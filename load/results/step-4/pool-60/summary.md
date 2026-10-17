| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 2399 | 40.8 | 52.6 | 61.1 | 0.00% | 31.8 | 21.47 | 5.31 | 9.39 | 4.24 | 1.13 | ✅ 3/3 |
| hot-account | 3 | 326 | 222.9 | 777.8 | 1144.8 | 0.00% | 39.0 | 183.28 | 59.32 | 2.64 | 1.52 | 0.46 | ✅ 3/3 |
