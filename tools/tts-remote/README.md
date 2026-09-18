# DXL1 remote gateway

The gateway listens on 127.0.0.1:9885 and forwards only allowlisted speech routes to 127.0.0.1:9884. Run using the existing studio Python environment with FastAPI, httpx and uvicorn. Put a random access token (at least 40 characters; recommended `secrets.token_urlsafe(48)`) in `access-key.txt` next to gateway.py. Do not publish that file. Missing or weak key fails startup.

Point a Cloudflare Tunnel hostname at the gateway, never directly at port 9884. Every API and audio request requires `Authorization: Bearer <key>`. Session output redacts the original local token. Key changes, admin pages and local-test endpoints are unavailable remotely. CORS supports standard Tauri Android/desktop origins; no cookie authentication. Authenticated generation limited to 20 submissions/minute. The access key grants use of the computer's TTS quota and access to audio; keep it private.

Computer and tunnel must remain online. Replacing the access key and restarting the gateway revokes the old key. The original local studio and its MiMo in-memory key are unchanged. Do not enable caching for audio or API routes. Gateway emits Cache-Control: no-store.
