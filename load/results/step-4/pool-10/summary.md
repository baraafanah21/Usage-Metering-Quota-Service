| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 1701 | 57.6 | 67.9 | 79.9 | 0.00% | 87.9 | 5.37 | 25.78 | 3.28 | 2.49 | 0.93 | ✅ 3/3 |
| hot-account | 3 | 356 | 272.7 | 355.1 | 419.7 | 0.00% | 88.1 | 27.80 | 124.59 | 2.48 | 0.88 | 0.43 | ✅ 3/3 |
