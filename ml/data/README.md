# ml/data

Nothing in here is committed except this file (see the root `.gitignore`).

| Folder | What goes in it |
|---|---|
| `raw/` | Exactly what was downloaded (`kaggle competitions download -c <slug> -p data/raw`). Never edited. |
| `processed/` | Anything derived from `raw/` by a script in `src/`. Safe to delete and rebuild. |
| `external/` | Third-party data you were allowed to use. Note its source and licence next to it. |

Record where each dataset came from (URL, date, version) in the experiment
README that first uses it. The fixed train/val split lives in `ml/splits/`
(committed), not here.
