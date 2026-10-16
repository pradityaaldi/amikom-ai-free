# amikom-ai-free-gateway

Gateway **OpenAI-compatible** untuk backend agentic AMIKOM (`https://ai.amikom.ac.id`).
Dengan ini, backend tim agent (mis. `miko`) bisa dipakai sebagai model chat biasa di
harness agentic apa pun yang mendukung API OpenAI — termasuk **pi**, Cursor, Continue,
LibreChat, **9Router**, `openai` SDK, dan lain-lain.

Tidak ada dependency eksternal. Hanya butuh **Node.js >= 18.17**.

```
┌──────────────┐   OpenAI JSON    ┌───────────┐   multipart    ┌────────────────────────────┐
│ agent harness│ ───────────────▶ │  gateway  │ ─────────────▶ │ ai.amikom.ac.id            │
│ (pi, dll)    │ ◀─────────────── │ :8787     │ ◀───────────── │ /agentic_backend/teams/... │
└──────────────┘   OpenAI SSE     └───────────┘   amikom SSE   └────────────────────────────┘
```

## Cara menjalankan

```bash
cd amikom-ai-free
npm start            # atau: node server.js
```

Default listen di `http://127.0.0.1:8787`.

```bash
cp .env.example .env # opsional, lalu export variabelnya
node --watch server.js   # mode dev
```

## Endpoint

| Method | Path                   | Keterangan                                       |
| ------ | ---------------------- | ------------------------------------------------ |
| GET    | `/health`              | Status gateway                                   |
| GET    | `/v1/models`           | Daftar model (= id team)                         |
| POST   | `/v1/chat/completions` | Chat completions, mendukung `stream: true/false` |

### Contoh

```bash
# non-streaming
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "miko",
    "messages": [{"role": "user", "content": "apa itu amikom?"}],
    "stream": false
  }'

# streaming
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "miko",
    "messages": [{"role": "user", "content": "apa itu amikom?"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

## Integrasi dengan pi agent

pi memakai `models.json` untuk endpoint yang kompatibel dengan OpenAI. Salin contoh
[`pi-models.example.json`](./pi-models.example.json) ke `~/.pi/agent/models.json`
(atau gabungkan ke file yang sudah ada):

```json
{
  "providers": {
    "amikom": {
      "baseUrl": "http://127.0.0.1:8787/v1",
      "api": "openai-completions",
      "apiKey": "amikom-free",
      "models": [
        {
          "id": "miko",
          "name": "MIKO (AMIKOM Agentic)",
          "reasoning": true,
          "input": ["text"],
          "compat": {
            "sendSessionAffinityHeaders": true,
            "sessionAffinityFormat": "openai",
            "supportsStore": false,
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": false,
            "supportsUsageInStreaming": true
          }
        }
      ]
    }
  }
}
```

`sendSessionAffinityHeaders` + `sessionAffinityFormat: "openai"` membuat pi mengirim
header `session_id`, sehingga gateway bisa memakai session yang sama dengan sesi pi
(memori percakapan tetap nyambung).

Lalu jalankan gateway, buka pi, dan pilih model `miko` lewat `/model`.

> Catatan: `apiKey: "amikom-free"` hanya dummy. Kalau `AMIKOM_GATEWAY_KEY` di-set,
> samakan nilainya.

## Integrasi dengan 9Router

[9Router](https://github.com/decolua/9router) adalah gateway/router LLM yang
menyatukan banyak provider di balik satu endpoint OpenAI-compatible. Karena
gateway ini juga OpenAI-compatible, ia bisa ditambahkan sebagai **Custom Provider**
sehingga model `miko` ikut ter-route bersama provider lain (mis. sebagai fallback).

Jalankan gateway dulu (`npm start`), lalu di dashboard 9Router:

```
Dashboard → Providers → Custom Providers → Add Custom Provider
```

Isi:

| Field      | Nilai                       |
| ---------- | --------------------------- |
| Type       | `openai-compatible`         |
| API Type   | `chat`                      |
| Name       | `AMIKOM` (bebas)            |
| Prefix     | `amikom`                    |
| Base URL   | `http://127.0.0.1:8787/v1`  |

Lalu **Add API Key Connection** dan isi key apa saja (mis. `amikom-free`) — field
key tidak boleh kosong. Kalau `AMIKOM_GATEWAY_KEY` di-set, samakan nilainya.

Model akan muncul sebagai `amikom/miko`. Saat request diteruskan ke gateway, 9Router
memvalidasi lewat `GET /v1/models` dan memakai `Authorization: Bearer <key>`, keduanya
sudah didukung gateway ini.

> Catatan:
>
> - Jika 9Router berjalan di **Docker**, `127.0.0.1` tidak berlaku — pakai
>   `http://host.docker.internal:8787/v1`.
> - Gateway harus selalu hidup; kalau mati, model `amikom/*` akan error. Jalankan
>   sebagai service (mis. PM2) bila perlu.
> - Tool calling tetap lewat shim (lihat bagian di atas) dan tidak selalu andal,
>   jadi paling cocok dipakai sebagai chat/fallback, bukan agentic coding berat.

## Pemetaan protokol

| AMIKOM (upstream)                                | OpenAI (gateway)                                       |
| ------------------------------------------------ | ------------------------------------------------------ |
| `TeamRunContent.reasoning_content`               | delta `reasoning_content` (thinking)                   |
| `TeamRunContent.content`                         | delta `content`                                        |
| `TeamRunCompleted.content`                       | fallback bila tidak ada delta `content`                |
| `TeamRunCompleted.metrics`                       | `usage` (input/output/cache/reasoning tokens)          |
| `TeamToolCall*` (tool internal tim)              | diabaikan (sudah dieksekusi di server)                 |
| Tool client via shim                           | `tool_calls` (format OpenAl) / `finish_reason: tool_calls` |
| `TeamSessionSummary*`, `TeamModelRequest*`       | diabaikan (hanya dipakai untuk metrik)                 |

Request OpenAI dipetakan ke `multipart/form-data` upstream:

| Field upstream | Sumber                                        |
| -------------- | --------------------------------------------- |
| `message`      | pesan user terakhir (atau seluruh transkrip)  |
| `stream`       | `body.stream`                                 |
| `session_id`   | header `session_id`/`x-session-id`, `body.session_id`, `body.user`, atau hash stabil |

## Konfigurasi (environment)

| Variabel                    | Default                                      | Keterangan |
| --------------------------- | -------------------------------------------- | ---------- |
| `HOST`                      | `127.0.0.1`                                  | Bind address |
| `PORT`                      | `8787`                                       | Port |
| `AMIKOM_BASE_URL`           | `https://ai.amikom.ac.id/agentic_backend`    | Base URL upstream |
| `AMIKOM_DEFAULT_TEAM`       | `miko`                                       | Team default |
| `AMIKOM_TEAMS`              | `miko`                                       | Daftar team (koma), dipakai sebagai id model |
| `AMIKOM_GATEWAY_KEY`        | _(kosong)_                                   | Jika diisi, client wajib kirim `Authorization: Bearer <key>` |
| `AMIKOM_SESSION_STRATEGY`   | `derive`                                     | `derive` / `random` / `header` |
| `AMIKOM_CONTEXT_MODE`       | `last`                                       | `last` (kirim turn terakhir, andalkan memori upstream) / `full` (gabung seluruh transkrip) |
| `AMIKOM_TOOL_MODE`          | `auto`                                       | `auto` / `shim` / `off` — prompt-based tool calling (lihat bagian di bawah) |
| `AMIKOM_TIMEOUT_MS`         | `180000`                                     | Timeout request ke upstream |
| `AMIKOM_KEEPALIVE_MS`       | `15000`                                      | Interval komentar keep-alive SSE |

### Session / memori percakapan

Backend AMIKOM menyimpan riwayat percakapan per `session_id`. Gateway menjaga
kesinambungan dengan urutan prioritas:

1. Header `session_id`, `x-session-id`, `x-client-request-id`, `x-session-affinity`
2. `body.session_id`
3. `body.user`
4. **derive**: hash stabil dari pesan user pertama — jadi selama pesan pertama
   percakapan tidak berubah (seperti di pi, yang selalu mengirim seluruh history),
   sesi tetap sama antar-turn.

Kalau ingin tanpa memori, set `AMIKOM_SESSION_STRATEGY=random`.

## Tool calling (eksperimental)

Upstream **tidak** mendukung OpenAI function calling native. Agent `miko`
memiliki tool sendiri (`think`, `analyze`, `delegate_task_to_member`) dan tidak
menerima definisi tool dari client.

Agar harness seperti pi tetap bisa memanggil tool (`write`, `edit`, `bash`, ...),
gateway menyediakan **shim berbasis prompt**: definisi tool + format output
disuntikkan ke pesan, lalu tool call dari model diubah kembali menjadi OpenAl
`tool_calls`.

```bash
# aktif otomatis saat request berisi `tools` (default)
AMIKOM_TOOL_MODE=auto
# paksa selalu aktif
AMIKOM_TOOL_MODE=shim
# matikan (tool client diabaikan)
AMIKOM_TOOL_MODE=off
```

Contoh request:

```json
{
  "model": "miko",
  "stream": false,
  "messages": [{ "role": "user", "content": "Buat file hello.txt berisi: Halo" }],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "write_file",
        "description": "Write content to a file",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
          "required": ["path", "content"]
        }
      }
    }
  ]
}
```

### Seberapa andal?

**Tidak seandal model dengan native tool calling.** Backend ini adalah asisten
topik AMIKOM, bukan model coding umum. Hasil pengujian:

| Tugas | Hasil |
| --- | --- |
| Tool call sederhana (`write_file hello.txt`) | umumnya **6/6** berhasil |
| Tugas kompleks ("buatkan website portfolio") | **campur** — kadang tool call, kadang menulis kode sebagai teks/prose |

Yang membantu: prompt shim membingkai tugas sebagai *"proyek Universitas AMIKOM
Yogyakarta"* sehingga lolos topic-guard. Meski begitu tetap ada variasi.

Kalau butuh agentic coding yang **andal** (bikin website, banyak file), pakai model
yang mendukung native tool calling. Banyak opsi gratis untuk pi, misalnya:

- Google AI Studio / Gemini free tier (native tools)
- Groq (Llama, Qwen, dsb.)
- OpenRouter model `:free` yang mendukung tools
- Ollama / LM Studio lokal (Qwen-Coder, dsb.)

Semua itu cukup ditambahkan sebagai provider `openai-completions` di
`~/.pi/agent/models.json`, tanpa gateway ini.

## Batasan

- **Tool calling hanya lewat shim** dan tidak selalu bisa diandalkan (lihat di atas).
- **Topik terbatas.** Agent `miko` dirancang untuk seputar AMIKOM; di luar itu ia
  bisa menolak atau membelokkan jawaban.
- **Streaming teks + reasoning** didukung; `logprobs`, `n > 1`, dan parameter
  sampling (temperature, top_p, dsb.) tidak diteruskan (upstream hanya menerima
  `message`, `stream`, `session_id`).
- Saat tool mode aktif, gateway mengirim ulang seluruh transkrip dan memakai
  session baru setiap request (stateless), jadi lebih boros token.

## Struktur proyek

```
server.js                  HTTP server + routing + streaming translation
src/config.js              Konfigurasi dari environment
src/upstream.js            Client ke backend AMIKOM
src/sse.js                 Parser Server-Sent Events
src/format.js              Konversi pesan/session/usage OpenAI <-> AMIKOM
src/tools.js               Prompt-based tool calling (shim) + parser
pi-models.example.json     Contoh config models.json untuk pi
test/smoke.sh              Smoke test end-to-end
```

## Test

```bash
npm start
# terminal lain:
npm run smoke
```

## Lisensi

MIT
