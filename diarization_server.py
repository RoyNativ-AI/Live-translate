"""
WebSocket server for speaker diarization using pyannote.audio.
Only handles speaker detection - transcription is done client-side via Web Speech API.
"""
import asyncio
import numpy as np
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import torch
import os

# Set HF_TOKEN environment variable before running:
# export HF_TOKEN=your_huggingface_token

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SAMPLE_RATE = 16000
PROCESS_INTERVAL = 2  # seconds - faster detection
BUFFER_MAX = 15  # seconds
CONTEXT_KEEP = 10  # seconds

# Load pyannote model
print("Loading pyannote speaker diarization model...")
from pyannote.audio import Pipeline
from huggingface_hub import login

login(token=os.environ["HF_TOKEN"])
pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")

if torch.backends.mps.is_available():
    print("Using MPS (Apple Silicon)")
    pipeline.to(torch.device("mps"))
else:
    print("Using CPU")

print("Model loaded!")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Client connected")

    audio_buffer = []
    last_speaker = None

    try:
        while True:
            data = await websocket.receive_bytes()
            audio_chunk = np.frombuffer(data, dtype=np.float32)
            audio_buffer.append(audio_chunk)

            total_samples = sum(len(c) for c in audio_buffer)

            # Trim buffer to max size
            while total_samples > SAMPLE_RATE * BUFFER_MAX and len(audio_buffer) > 1:
                total_samples -= len(audio_buffer.pop(0))

            # Process when we have enough audio
            if total_samples >= SAMPLE_RATE * PROCESS_INTERVAL:
                combined = np.concatenate(audio_buffer)
                waveform = torch.tensor(combined).unsqueeze(0)

                try:
                    # Run diarization
                    result = pipeline({
                        "waveform": waveform,
                        "sample_rate": SAMPLE_RATE
                    })

                    duration = len(combined) / SAMPLE_RATE

                    # Handle different pyannote versions
                    if hasattr(result, 'itertracks'):
                        # Old API - Annotation object
                        tracks = list(result.itertracks(yield_label=True))
                    elif hasattr(result, 'speaker_diarization'):
                        # Newer API - DiarizeOutput object
                        tracks = list(result.speaker_diarization.itertracks(yield_label=True))
                    else:
                        # Try to find the annotation
                        print(f"Result type: {type(result)}, attrs: {dir(result)}")
                        continue

                    # Build segments list with timestamps
                    segments = []
                    current_speaker_num = 1
                    print(f"\n--- Diarization result (duration: {duration:.1f}s) ---")
                    for turn, _, speaker in tracks:
                        speaker_num = int(speaker.split("_")[-1]) + 1
                        speaker_num = min(speaker_num, 4)
                        segments.append({
                            "start": round(turn.start, 2),
                            "end": round(turn.end, 2),
                            "speaker": speaker_num
                        })
                        print(f"  [{turn.start:.1f}s - {turn.end:.1f}s] Speaker {speaker_num}")
                        # Track current speaker (last one speaking at end)
                        if turn.end >= duration - 1.0:
                            current_speaker_num = speaker_num

                    # Send all segments + current speaker
                    await websocket.send_json({
                        "speaker": current_speaker_num,
                        "segments": segments,
                        "duration": round(duration, 2)
                    })

                    if current_speaker_num != last_speaker:
                        last_speaker = current_speaker_num
                        print(f">>> Speaker changed to: {current_speaker_num}")

                except Exception as e:
                    print(f"Diarization error: {e}")
                    import traceback
                    traceback.print_exc()

                # Keep context for continuity
                keep_samples = SAMPLE_RATE * CONTEXT_KEEP
                audio_buffer = [combined[-keep_samples:]]

    except Exception as e:
        print(f"Connection closed: {e}")
    finally:
        print("Client disconnected")


if __name__ == "__main__":
    print("Starting diarization server on port 8766...")
    uvicorn.run(app, host="0.0.0.0", port=8766)
