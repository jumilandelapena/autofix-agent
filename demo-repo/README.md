# demo-inventory-api

A tiny Express 5 + TypeScript inventory API. It exists as a target for
[autofix-agent](https://github.com/jumilandelapena/autofix-agent): six bugs are
planted on purpose and described in [`issues.json`](./issues.json). Each one is
filed as a GitHub issue with the same number, and the agent opens a pull
request against this repository for each.

Do not fix the bugs by hand on `main`; the demo depends on them staying there.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/items?q=&offset=&limit=` | case-insensitive name search, paginated (`limit` default 20) |
| GET | `/items/:id` | one item, 404 if unknown |
| GET | `/items/:id/price?discount=` | price after a percentage discount (0-100) |
| POST | `/items` | create; `{ name, price, quantity, tags? }` |
| PUT | `/items/:id` | partial update, persisted |
| DELETE | `/items/:id` | 204, or 404 if unknown |

## Develop

```bash
npm install
npm test        # vitest
npm run lint    # tsc --noEmit
npm run dev     # tsx src/server.ts on :3000
```

The existing tests pass on `main`: they deliberately avoid the planted bugs so
that the agent has a green baseline to compare against.
