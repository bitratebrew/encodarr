# encodarr

A self-hosted media re-encoding service. Scans your library, identifies files
that don't match your target codec/format profile, and re-encodes them automatically.

## Project Structure

```
encodarr/
├── app/
│   ├── main.py        # Application entry point
│   ├── scanner.py     # Media directory scanner
│   ├── encoder.py     # Encoding queue and FFmpeg wrapper
│   ├── database.py    # Database models and access layer
│   ├── api/
│   │   └── routes.py  # HTTP API route definitions
│   ├── static/        # Frontend assets (JS, CSS)
│   └── templates/     # HTML templates
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── .gitignore
```

## Quickstart

Requires [Docker](https://docs.docker.com/get-docker/) with Compose.

1. Clone the repo and move into it:
   ```bash
   git clone https://github.com/bitratebrew/encodarr.git
   cd encodarr
   ```
2. By default `docker-compose.yml` maps a `./media` folder (next to the compose file) into the
   container — either create that folder and put/link your media there, or edit the `volumes:`
   section to point at your actual library.
3. Build and start:
   ```bash
   docker compose up --build -d
   ```
4. Open `http://<your-host>:6767` in a browser.

No GPU is required — Encodarr falls back to software encoding (libx265/libsvtav1) automatically.
Hardware encoding (NVENC or VAAPI) is detected at startup if available.

### Unraid

Use `docker-compose.unraid.yml` instead of `docker-compose.yml` — same steps, but every volume path
is a placeholder you need to fill in with your own share paths (no assumed defaults). See the
comments in that file for enabling NVIDIA or AMD/Intel hardware encoding. An `unraid-template.xml` is
also included for adding the container directly via the Unraid Docker UI.
