| Scenario | Runs | Req/s | p50 ms | p95 ms | p99 ms | Error rate | Pool waiting (avg) | Tx mean ms | Acquire mean ms | Lock hold mean ms | CPU db | CPU api | verify.sql |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-: |
| spread | 3 | 2190 | 44.6 | 55.6 | 69.2 | 0.00% | 77.1 | 9.12 | 34.11 | 4.64 | 3.41 | 1.07 | ✅ 3/3 |
| hot-account | 3 | 320 | 293.2 | 457.4 | 567.8 | 0.00% | 78.0 | 62.44 | 247.23 | 2.67 | 1.07 | 0.48 | ✅ 3/3 |
| exhaust | 3 | 334 | 274.5 | 432.9 | 550.5 | 0.00% | 64.5 | 59.17 | 228.47 | 2.50 | 0.82 | 0.49 | ✅ 3/3 |
