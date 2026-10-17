| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 2178 | 44.3 | 56.8 | 67.5 | 0.00% | 75.7 | 8.19 | 17.42 | 4.54 | 3.35 | 1.10 | ✅ 3/3 |
| hot-account | 3 | 338 | 276.3 | 435.4 | 544.4 | 0.00% | 78.1 | 58.84 | 116.24 | 2.55 | 1.07 | 0.47 | ✅ 3/3 |
| retry-storm | 3 | 2979 | 32.5 | 40.4 | 50.5 | 0.00% | 72.8 | 5.10 | 12.11 | 3.45 | 2.47 | 1.16 | ✅ 3/3 |
