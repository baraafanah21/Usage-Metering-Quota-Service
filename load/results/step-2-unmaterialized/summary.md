| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 2003 | 48.2 | 60.2 | 73.7 | 0.00% | 76.5 | 9.06 | 19.03 | 4.45 | 4.61 | 1.11 | ✅ 3/3 |
| hot-account | 3 | 421 | 216.4 | 357.7 | 455.4 | 0.00% | 78.0 | 47.21 | 93.35 | 2.10 | 1.23 | 0.40 | ✅ 3/3 |
| exhaust | 3 | 366 | 250.4 | 399.6 | 502.7 | 0.00% | 66.5 | 53.81 | 104.45 | 2.33 | 0.98 | 0.49 | ✅ 3/3 |
