| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 2167 | 44.5 | 57.3 | 68.3 | 0.00% | 76.5 | 8.24 | 17.52 | 4.55 | 3.38 | 1.11 | ✅ 3/3 |
| hot-account | 3 | 335 | 277.6 | 441.8 | 556.5 | 0.00% | 78.2 | 59.38 | 117.12 | 2.57 | 1.08 | 0.47 | ✅ 3/3 |
| exhaust | 3 | 341 | 267.1 | 429.0 | 532.7 | 0.00% | 63.6 | 57.80 | 110.30 | 2.47 | 0.85 | 0.50 | ✅ 3/3 |
