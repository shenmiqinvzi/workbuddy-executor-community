# F1 — bug fix + verification: Java discount

Fix `src/Discount.java` so `apply` clamps the discount rate to [0,1], returns the original price for NaN rate, and never returns a negative amount. Preserve normal behavior for valid rates. Add/update tests in `test/DiscountTest.java`. Do not add dependencies.

Acceptance: compile/run the test using only installed JDK or provide a dependency-free executable test. Cases: price 100/rate .2 => 80; rate -1 => 100; rate 2 => 0; NaN => 100; price -5/rate .5 => 0. Report exact command and exit code.
