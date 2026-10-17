| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 1916 | 50.3 | 65.9 | 75.1 | 0.00% | 76.6 | 9.56 | 19.96 | – | 3.27 | 1.09 | ✅ 3/3 |
| hot-account | 3 | 259 | 363.0 | 573.1 | 714.6 | 0.00% | 78.0 | 76.96 | 150.79 | – | 0.95 | 0.46 | ✅ 3/3 |
| retry-storm | 3 | 3255 | 29.7 | 35.2 | 44.7 | 0.00% | 73.5 | 4.91 | 11.28 | – | 1.33 | 1.15 | ✅ 3/3 |
