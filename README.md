# boromir

**BRL — Batch Request Language** for REST APIs.

Define API workflows as plain `.req` files. Chain responses between steps. Run end-to-end flows from a single command. Get rich HTML reports.

---

## What is BRL?

BRL (Batch Request Language) is a minimal, human-readable format for scripting sequences of HTTP requests. Each line is one request: `METHOD /path [JSON body]`. Use `{{$N.field}}` to wire the output of one step into the input of the next.

```
POST /api/users    {"name":"alice","role":"admin"}
GET  /api/users/{{$0.id}}
POST /api/tokens   {"userId":"{{$prev.id}}","ttl":3600}
DELETE /api/users/{{$0.id}}
```

`.req` files are plain text — diff them, version them, review them in PRs. No DSLs, no YAML, no GUI required.

---

## Features

- **Response chaining** — `{{$0.field}}`, `{{$prev.field}}`, `{{$N.items.0.id}}`
- **Session management** — login once, token reused across all calls
- **HTML reports** with per-step detail and execution history
- **mTLS support** — client cert, key, and CA cert
- **Swagger/OpenAPI browser** — explore and inspect any documented API

---

## Install

```sh
npm install -g boromir
```

Or run without installing:

```sh
npx boromir --help
```

### Development

```sh
git clone https://github.com/your-org/boromir
cd boromir
npm install
npm run dev -- --help       # run via tsx (no build needed)
npm run build               # compile to dist/
```

---

## Quick Start

### 1. Authenticate

```sh
boromir --base https://api.example.com login -u admin -p secret
```

Token is saved to `~/.boromir_session.json` (chmod 600) and reused for all subsequent calls.

### 2. Make a single request

```sh
boromir req GET /api/users
boromir req POST /api/users -d '{"name":"alice","role":"admin"}'
boromir req GET /api/users -q status=active -q page=1
boromir req PUT /api/users/42 -d '{"name":"bob"}' -H "X-Trace: abc"
```

### 3. Run a BRL file

```sh
boromir run example.req
boromir run workflow.req --report report.html
boromir run step1.req step2.req --keep-going
```

---

## BRL Syntax

A `.req` file is a sequence of HTTP requests, one per line:

```
# Comments start with #
METHOD /path
METHOD /path?query=value
METHOD /path {"json":"body"}
```

### Response Chaining

Responses are indexed in execution order, starting at 0 and shared across all files in a single `run`.

| Reference | Resolves to |
|-----------|-------------|
| `{{$0.field}}` | Field `field` from response 0 |
| `{{$0.items.0.id}}` | Nested/array traversal |
| `{{$prev.field}}` | Field from the last response |
| `{{$N}}` | Full JSON of response N |

### Full Example

```
# step 0 — create an order
POST /api/orders {"product":"widget","qty":3}

# step 1 — apply a discount using the order ID from step 0
POST /api/discounts {"orderId":"{{$0.id}}","pct":10}

# step 2 — confirm the order with the discount code from step 1
GET /api/orders/{{$0.id}}?discountCode={{$prev.code}}

# step 3 — clean up
DELETE /api/orders/{{$0.id}}
```

---

## Global Options

These options apply to all commands and must be placed before the subcommand:

```sh
boromir [global options] <command> [command options]
```

| Flag | Description | Default |
|------|-------------|---------|
| `--base <url>` | API base URL | `https://localhost:8080` |
| `--login-path <path>` | Login endpoint path | `/api/auth/login` |
| `--token-field <field>` | Token field in login response | `token` |
| `--cert <file>` | Client cert PEM (mTLS) | |
| `--key <file>` | Client key PEM (mTLS) | |
| `--cacert <file>` | CA cert PEM to verify server | |
| `--insecure` | Skip TLS verification | |

---

## Commands

### `login`

Authenticate and store a bearer token:

```sh
boromir --base <url> login -u <username> -p <password>
```

### `req`

Make a single authenticated request:

```sh
boromir req <METHOD> <endpoint> [options]

Options:
  -d, --data <json>      JSON request body
  -q, --params <K=V>     Query param (repeatable: -q a=1 -q b=2)
  -H, --header <K:V>     Extra header (repeatable)
```

### `run`

Execute one or more `.req` files in BRL batch mode:

```sh
boromir run <file.req...> [options]

Options:
  --keep-going           Continue on HTTP error instead of stopping
  --report <file.html>   Write HTML report (history appended on each run)
```

### `docs`

Browse Swagger/OpenAPI documentation (requires auth):

```sh
boromir docs                      # list all endpoints
boromir docs -f /api/users        # filter by path substring
boromir docs -e /api/users        # show full detail for matching endpoints
```

---

## mTLS

```sh
boromir \
  --base https://secure.api.example.com \
  --cert certs/client.pem \
  --key  certs/client.key \
  --cacert certs/ca.pem \
  login -u admin -p secret
```

---

## License

MIT
