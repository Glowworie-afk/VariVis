# VariVis

Interactive visual analysis system for Theme and Variations music.

**Full documentation: [PRODUCT.md](PRODUCT.md)**

---

## Quick Start

**Backend**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend**

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` — the Vite dev server proxies `/api` to `localhost:8000`.

---

## Project Structure

```
VariVis/
├── backend/        # FastAPI server (Python 3.11)
│   ├── app/
│   │   ├── api/        # Route handlers
│   │   ├── services/   # Business logic
│   │   └── core/       # Config / path constants
│   ├── data/       # Annotations, MIDI, PDF, MusicXML
│   ├── features/   # Extracted feature JSON files
│   └── tests/      # Unit + API integration tests (196 cases)
│
└── frontend/       # React 18 + TypeScript (Vite)
    └── src/
        ├── api/        # Backend request wrappers
        ├── features/   # UI components by domain
        ├── hooks/      # State logic
        └── i18n/       # EN/ZH translations
```

---

## Running Tests

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/ -v
```

---

## Dataset

The built-in TV Dataset contains 348 extracted versions of Theme and Variations works by Beethoven, Mozart, and Haydn. Audio files (`TV_dataset_audio/`) are not included in the repository.

To analyse a custom piece, use the **Upload** button in the frontend sidebar.
