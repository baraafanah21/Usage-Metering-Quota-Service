| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 1845 | 52.5 | 70.0 | 80.5 | 0.00% | 76.9 | 9.93 | 20.74 | 5.49 | 3.20 | 1.10 | ✅ 3/3 |
| hot-account | 3 | 279 | 333.1 | 537.7 | 682.6 | 0.00% | 78.2 | 71.21 | 140.49 | 3.18 | 0.90 | 0.45 | ✅ 3/3 |
| exhaust | 3 | 286 | 323.2 | 514.3 | 655.9 | 0.00% | 66.8 | 69.06 | 130.93 | 3.04 | 0.76 | 0.52 | ✅ 3/3 |
