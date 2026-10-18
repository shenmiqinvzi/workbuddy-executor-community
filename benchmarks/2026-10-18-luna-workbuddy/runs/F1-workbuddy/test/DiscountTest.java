public final class DiscountTest {
    private static int passed = 0;

    private static void check(String name, double actual, double expected) {
        if (Double.compare(actual, expected) != 0) {
            throw new AssertionError(name + ": expected " + expected + " but was " + actual);
        }
        passed++;
        System.out.println("PASS " + name + " => " + actual);
    }

    private static void checkTrue(String name, boolean condition) {
        if (!condition) {
            throw new AssertionError(name);
        }
        passed++;
        System.out.println("PASS " + name);
    }

    public static void main(String[] args) {
        // Existing behavior must be preserved for valid rates.
        check("valid rate 100/0.2", Discount.apply(100, .2), 80.0);
        check("no discount 100/0.0", Discount.apply(100, 0.0), 100.0);
        check("full discount 100/1.0", Discount.apply(100, 1.0), 0.0);
        check("half discount 50/0.5", Discount.apply(50, .5), 25.0);

        // Rate clamping.
        check("negative rate clamped 100/-1", Discount.apply(100, -1), 100.0);
        check("rate above 1 clamped 100/2", Discount.apply(100, 2), 0.0);
        check("rate below 0 clamped 100/-0.5", Discount.apply(100, -0.5), 100.0);
        check("rate above 1 clamped 100/1.5", Discount.apply(100, 1.5), 0.0);

        // NaN rate returns the original price untouched.
        check("NaN rate 100/NaN", Discount.apply(100, Double.NaN), 100.0);
        check("NaN rate keeps original price 37.5", Discount.apply(37.5, Double.NaN), 37.5);

        // Never negative.
        check("negative price -5/0.5", Discount.apply(-5, .5), 0.0);
        check("negative price -100/0", Discount.apply(-100, 0.0), 0.0);
        check("negative price -100/1", Discount.apply(-100, 1.0), 0.0);

        // Large rate values must not overflow into NaN/Infinity results.
        checkTrue("infinite rate clamped 100/+Inf",
                Double.compare(Discount.apply(100, Double.POSITIVE_INFINITY), 0.0) == 0);
        check("infinite negative rate 100/-Inf", Discount.apply(100, Double.NEGATIVE_INFINITY), 100.0);

        System.out.println("ALL TESTS PASSED (" + passed + " checks)");
    }
}
