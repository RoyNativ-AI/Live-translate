"""
Real-time speaker diarization server using Diart.
Diart is optimized for streaming - updates every 500ms.
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

# Load Diart pipeline
print("Loading Diart real-time diarization...")
from huggingface_hub import login
login(token=os.environ["HF_TOKEN"])

from diart import SpeakerDiarization
from diart.sources import AudioSource
from diart.inference import StreamingInference
import diart.operators as dops
from pyannote.core import Annotation

# Configure Diart with lower latency
config = SpeakerDiarization.Config(
    step=0.5,  # Process every 0.5 seconds
    latency=0.5,  # Minimum latency
    tau_active=0.5,  # Lower threshold for speaker activity
    rho_update=0.1,  # More frequent updates
    delta_new=0.5,  # Lower threshold for new speaker detection
)

pipeline = SpeakerDiarization(config)

# Use MPS if available
device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
print(f"Using device: {device}")

print("Diart loaded!")


class WebSocketAudioSource:
    """Audio source that receives data from WebSocket."""

    def __init__(self, sample_rate: int = 16000):
        self.sample_rate = sample_rate
        self.buffer = []
        self.is_active = True

    def add_audio(self, audio_data: np.ndarray):
        self.buffer.append(audio_data)

    def read_chunk(self, duration: float) -> np.ndarray:
        """Read audio chunk of specified duration."""
        samples_needed = int(duration * self.sample_rate)

        if not self.buffer:
            return np.zeros(samples_needed, dtype=np.float32)

        # Concatenate buffer
        combined = np.concatenate(self.buffer)
        self.buffer = []

        # Pad or trim to exact size
        if len(combined) < samples_needed:
            combined = np.pad(combined, (0, samples_needed - len(combined)))
        elif len(combined) > samples_needed:
            # Keep excess for next chunk
            self.buffer = [combined[samples_needed:]]
            combined = combined[:samples_needed]

        return combined


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Client connected")

    audio_buffer = []
    last_speaker = None
    speaker_map = {}  # Map diart speaker names to numbers

    try:
        while True:
            data = await websocket.receive_bytes()
            audio_chunk = np.frombuffer(data, dtype=np.float32)
            audio_buffer.append(audio_chunk)

            total_samples = sum(len(c) for c in audio_buffer)

            # Process when we have enough audio (1 second)
            if total_samples >= SAMPLE_RATE * 1.0:
                combined = np.concatenate(audio_buffer)
                waveform = torch.tensor(combined).unsqueeze(0)

                try:
                    # Run diarization
                    result = pipeline(waveform, SAMPLE_RATE)

                    if result and len(result) > 0:
                        # Get the most recent speaker
                        duration = len(combined) / SAMPLE_RATE

                        # Find speaker at the end of the audio
                        current_speaker = None
                        for segment, track, speaker in result.itertracks(yield_label=True):
                            if segment.end >= duration - 0.5:
                                current_speaker = speaker

                        if current_speaker:
                            # Map speaker name to number
                            if current_speaker not in speaker_map:
                                speaker_map[current_speaker] = len(speaker_map) + 1

                            speaker_num = speaker_map[current_speaker]
                            speaker_num = min(speaker_num, 4)  # Cap at 4 speakers

                            if speaker_num != last_speaker:
                                last_speaker = speaker_num
                                await websocket.send_json({"speaker": speaker_num})
                                print(f"Speaker: {speaker_num}")

                except Exception as e:
                    print(f"Diarization error: {e}")

                # Keep last 2 seconds for context
                keep_samples = SAMPLE_RATE * 2
                if len(combined) > keep_samples:
                    audio_buffer = [combined[-keep_samples:]]
                else:
                    audio_buffer = [combined]

    except Exception as e:
        print(f"Connection closed: {e}")
    finally:
        print("Client disconnected")


if __name__ == "__main__":
    print("Starting Diart server on port 8766...")
    uvicorn.run(app, host="0.0.0.0", port=8766)
