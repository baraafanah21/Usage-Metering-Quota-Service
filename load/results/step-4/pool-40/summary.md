| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 2361 | 41.4 | 50.9 | 60.5 | 0.00% | 53.0 | 14.62 | 10.80 | 7.24 | 3.99 | 1.13 | ✅ 3/3 |
| hot-account | 3 | 325 | 255.6 | 603.2 | 854.0 | 0.00% | 58.6 | 122.56 | 90.12 | 2.63 | 1.31 | 0.47 | ✅ 3/3 |
