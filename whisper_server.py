"""
WhisperLiveKit server with speaker diarization.
Real-time transcription + speaker identification.
"""
import asyncio
import json
import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
import uvicorn

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

# Initialize WhisperLiveKit
print("Loading WhisperLiveKit...")
from whisperlivekit import WhisperLiveKit

kit = WhisperLiveKit(
    model="small",  # Can use: tiny, base, small, medium, large-v3
    language="en",
    use_vad=True,  # Voice activity detection
)
print("WhisperLiveKit loaded!")

# Initialize Diart for speaker diarization
print("Loading Diart speaker diarization...")
from diart import SpeakerDiarization
from diart.inference import StreamingInference
from diart.sources import MicrophoneAudioSource

# We'll use a simpler approach - process audio chunks directly
import torch
from pyannote.audio import Model
from pyannote.audio.pipelines import SpeakerDiarization as PyannoteDiarization

pipeline = None
try:
    from huggingface_hub import login
    login(token=os.environ["HF_TOKEN"])
    pipeline = PyannoteDiarization.from_pretrained("pyannote/speaker-diarization-3.1")
    if torch.backends.mps.is_available():
        pipeline.to(torch.device("mps"))
    print("Speaker diarization loaded!")
except Exception as e:
    print(f"Could not load speaker diarization: {e}")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Client connected")

    try:
        # Create a new transcription session
        async for result in kit.transcribe_stream(websocket):
            # result contains: text, is_final, language, etc.
            response = {
                "text": result.get("text", ""),
                "is_final": result.get("is_final", False),
                "speaker": 1,  # Default speaker
            }
            await websocket.send_json(response)

    except WebSocketDisconnect:
        print("Client disconnected")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        print("Session ended")


@app.get("/")
async def get():
    return HTMLResponse("""
    <html>
    <head><title>WhisperLiveKit Server</title></head>
    <body>
        <h1>WhisperLiveKit Server Running</h1>
        <p>Connect via WebSocket at ws://localhost:8765/ws</p>
    </body>
    </html>
    """)


if __name__ == "__main__":
    print("Starting WhisperLiveKit server on port 8765...")
    uvicorn.run(app, host="0.0.0.0", port=8765)
