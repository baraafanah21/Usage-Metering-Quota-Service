| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 1982 | 48.4 | 62.7 | 75.3 | 0.00% | 76.5 | 9.14 | 19.23 | 4.26 | 3.26 | 1.11 | ✅ 3/3 |
| hot-account | 3 | 375 | 247.2 | 399.8 | 509.6 | 0.00% | 78.7 | 53.09 | 104.84 | 2.32 | 1.02 | 0.47 | ✅ 3/3 |
| exhaust | 3 | 350 | 260.0 | 414.6 | 517.0 | 0.00% | 63.0 | 56.35 | 107.85 | 2.42 | 0.84 | 0.54 | ✅ 3/3 |
