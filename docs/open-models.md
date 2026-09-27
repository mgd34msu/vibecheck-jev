# Use an open Jev model

An open Jev model runs on your own machine. Every one below answers the same System One questions as hosted Jev, so vibecheck-jev treats them all the same way once they are running. They differ in size, in what they need to run, and in how much of an agent's work they can read at once.

## Choose a model

| Model                           | Maker              | Runs on                                                                  | Reads at most        | Best for                                                                 |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------ |
| [Laya](#laya)                   | Convai Innovations | CPU, about 2 GB of RAM                                                   | 512 tokens of state  | The short checks, on any machine, with nothing to set up but one command |
| [Jev-Style](#jev-style)         | chaoliangUNSW      | CPU or GPU, through Python (torch) or llama.cpp                          | 25,600 tokens        | The checks that read long evidence, on a modest machine                  |
| [OpenJev](#openjev-github30)    | GitHub30           | A GPU running an instruct model you choose                               | Depends on the model | Using a model you already have                                           |
| [openjev](#openjev-razorback16) | razorback16        | An NVIDIA GPU with 24 GB of VRAM, or Apple silicon with about 16 GB free | Depends on the model | The fastest readings, when you have the hardware                         |

A common setup is Laya for the short checks, Jev-Style for the evidence-heavy ones, and hosted Jev behind both as a fallback; [combine several models](#combine-several-models) shows that config.

## The same five steps for every model

1. **Get and start the model**, as its section below describes. Each one ends with a server answering on a local port.
2. **Add it to `sources`** in the config file (see [where the file is](../README.md#the-config-file)). Sources are tried in order, so put the one you want first at the top.
3. **Check that it answers:** `vibecheck-jev sources --source <id>`. This sends one small reading and reports the answer time, the model name and, where the server supports it, the models it serves.
4. **Measure it against the checks:** `vibecheck-jev measure fixtures --source <id> --runs 3`. The checks' thresholds were set on hosted Jev, and an open model often reads the same examples a little higher or lower. The output ends with every fixture that fails on this model.
5. **Calibrate or route.** For each check with failing fixtures, either set a threshold for this model under `checks.<check id>.sourceThresholds.<source id>` and measure again, or send that check to another source with `checks.<check id>.sources`. [Calibrate](../README.md#calibrate) explains the tools in more detail.

The config keys for every source kind are listed under [sources](../README.md#sources).

## Laya

[Laya](https://huggingface.co/convaiinnovations/laya) is a small open model built for System One questions, released by Convai Innovations with Apache-2.0 weights. It runs on a CPU through ONNX Runtime, using [@receptron/laya](https://github.com/receptron/laya). vibecheck-jev installs and serves it for you.

**You need:** npm (for the install), about 2 GB of free RAM, and about 1.7 GB of disk for the weights. The weights download on first use into `~/.cache/receptron-laya`; set `LAYA_CACHE` or the source's `load.cacheDir` to put them elsewhere.

**Install and start it:**

```bash
vibecheck-jev laya install    # installs Laya and ONNX Runtime into the data folder
vibecheck-jev laya serve      # loads the model and answers on 127.0.0.1:8723
```

Nothing is installed into the plugin folder. The server runs under Bun or Node.js.

**Connect it:**

```jsonc
"sources": [
  { "kind": "laya", "id": "laya", "port": 8723, "autostart": false },
  { "kind": "typesafe", "id": "typesafe" }
]
```

With `"autostart": true`, a hook or the ledger starts `laya serve` in the background when it finds Laya not running. That first reading goes to the next source while the model loads.

**What to expect:** Laya reads at most 512 tokens of state, choice options up to 192 tokens, and about 20 options per choice. A longer reading skips Laya and goes to the next source, and the skip is recorded. Laya also reads many of the checks' examples differently from hosted Jev: at the built-in thresholds, 76 of 139 fixture readings fail on it. So measure it (step 4), then either give it its own thresholds or send it only the short checks:

```jsonc
"checks": {
  "vibecheck.question-answered": { "sources": ["laya", "typesafe"] },
  "vibecheck.user-pauses": { "sources": ["laya", "typesafe"] }
}
```

## Jev-Style

[Jev-Style](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3) is a family of open decision models by chaoliangUNSW (Apache-2.0). The 0.8B v3 model reads up to 25,600 tokens, enough for the checks that read long evidence. There is also a larger [2B v2 model](https://huggingface.co/chaoliangUNSW/Jev-Style-Qwen3.5-2B-Decision-v2) and GGUF and MLX builds of each.

Jev-Style ships as a Python library with no server, so this repository includes a small optional server for it in [adapters/jev-style](../adapters/jev-style/README.md). vibecheck-jev never installs or starts it; you run it yourself.

**You need:** Python 3 and the Hugging Face CLI (`pip install -U huggingface_hub`). For the standard build, torch and `transformers` 5.0 or later, which the model's requirements file installs. For the GGUF build, llama.cpp instead of torch.

**Download and install it:**

```bash
hf download chaoliangUNSW/Jev-Style-0.8B-Decision-v3 --local-dir ./Jev-Style-0.8B-Decision-v3
python -m venv .venv && . .venv/bin/activate
pip install -r ./Jev-Style-0.8B-Decision-v3/requirements.txt
```

**Start the server** from this repository:

```bash
python adapters/jev-style/server.py --model-dir ./Jev-Style-0.8B-Decision-v3 --port 8766
```

For the GGUF build (from the [GGUF repository](https://huggingface.co/chaoliangUNSW/Jev-Style-0.8B-Decision-v3-GGUF), also available through LM Studio), use `--runtime gguf` and follow the adapter's README to build the scorer against llama.cpp.

**Connect it:**

```jsonc
{
  "kind": "openjev",
  "id": "jev-style",
  "baseURL": "http://127.0.0.1:8766",
  "model": "jev-style",
  "limits": { "maxStateTokens": 25600 },
}
```

**What to expect:** the adapter maps each answer from the model's library format into the System One format, based on the model card. It has not yet been run against the real model, so measure it (step 4) before relying on it.

## OpenJev (GitHub30)

[OpenJev](https://github.com/GitHub30/OpenJev) (MIT) turns an ordinary Hugging Face instruct model, such as Qwen, Llama, Gemma or SmolLM, into a System One server. You choose the model. Its documentation suggests Qwen2.5-7B on an A100 or L4 GPU and Qwen2.5-1.5B on a T4.

**You need:** Python 3 with [uv](https://docs.astral.sh/uv/), and a GPU with CUDA PyTorch installed first. The model itself downloads from Hugging Face when the server starts.

**Install and start it:**

```bash
git clone https://github.com/GitHub30/OpenJev.git && cd OpenJev
uv venv && uv pip install -e ".[hf,server,dev]"
openjev serve --model Qwen/Qwen2.5-1.5B-Instruct --port 8000
```

**Connect it:** the server answers on `http://127.0.0.1:8000` with the model name `jev-latest`.

```jsonc
{
  "kind": "openjev",
  "id": "openjev",
  "baseURL": "http://127.0.0.1:8000",
  "model": "jev-latest",
}
```

**What to expect:** the readings come from a general-purpose instruct model, not one trained for these questions, so they can sit well away from the built-in thresholds. Measure it (step 4) before relying on it.

## openjev (razorback16)

[openjev](https://github.com/razorback16/openjev) serves DiffusionGemma 26B-A4B (Apache-2.0, NVIDIA and Google) as a System One server. It is the heaviest open option and the fastest on capable hardware: its README reports 31 ms for a three-question request on an RTX PRO 6000. It can also serve smaller models such as Laya on a CPU; see its README.

**You need:** an NVIDIA GPU with at least 24 GB of VRAM and Docker, or Apple silicon with about 16 GB of free memory and Python 3.

**Install and start it** with Docker:

```bash
git clone https://github.com/razorback16/openjev && cd openjev
docker compose up -d
```

or on Apple silicon without Docker:

```bash
git clone https://github.com/razorback16/openjev && cd openjev
pip install -e '.[mlx]'
OPENJEV_BACKEND=mlx python -m openjev
```

**Connect it:** the server answers on `http://127.0.0.1:8080` with the model name `openjev-latest`.

```jsonc
{
  "kind": "openjev",
  "id": "openjev-gemma",
  "baseURL": "http://127.0.0.1:8080",
  "model": "openjev-latest",
}
```

## Server keys

Both open Jev servers accept an optional key, which you set on the server with `OPENJEV_API_KEY`. Give vibecheck-jev the same key by naming the variable on the source, as `"auth": { "apiKeyEnv": "OPENJEV_API_KEY" }`, or put it inline with `"auth": { "apiKey": "…" }`. Without a key on the server, leave `auth` out.

## Combine several models

List sources in order and route each check to the models that suit it. This config sends the short checks to Laya, the evidence-heavy checks to Jev-Style, and keeps hosted Jev as the fallback for any reading the local models skip or cannot answer:

```jsonc
"sources": [
  { "kind": "laya", "id": "laya", "port": 8723, "autostart": true },
  { "kind": "openjev", "id": "jev-style", "baseURL": "http://127.0.0.1:8766", "model": "jev-style", "limits": { "maxStateTokens": 25600 } },
  { "kind": "typesafe", "id": "typesafe" }
],
"checks": {
  "vibecheck.question-answered": { "sources": ["laya", "typesafe"] },
  "vibecheck.user-pauses": { "sources": ["laya", "typesafe"] },
  "vibecheck.claim-grounded": { "sources": ["jev-style", "typesafe"] },
  "vibecheck.claims-done": { "sources": ["jev-style", "typesafe"] }
}
```

Leave out the hosted source to run fully locally. When no listed source can answer a reading, the check lets the work go ahead and records that no reading was taken.
