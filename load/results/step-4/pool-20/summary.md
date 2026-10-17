| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 2190 | 44.1 | 56.5 | 68.6 | 0.00% | 75.9 | 8.16 | 17.32 | 4.53 | 3.41 | 1.11 | ✅ 3/3 |
| hot-account | 3 | 334 | 278.4 | 437.9 | 555.0 | 0.00% | 78.1 | 59.58 | 117.30 | 2.58 | 1.08 | 0.47 | ✅ 3/3 |
