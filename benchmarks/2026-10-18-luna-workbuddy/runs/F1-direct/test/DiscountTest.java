public final class DiscountTest {
    public static void main(String[] args) {
        assertEquals(80.0, Discount.apply(100, .2), "valid rate");
        assertEquals(100.0, Discount.apply(100, -1), "rate below zero");
        assertEquals(0.0, Discount.apply(100, 2), "rate above one");
        assertEquals(100.0, Discount.apply(100, Double.NaN), "NaN rate");
        assertEquals(0.0, Discount.apply(-5, .5), "negative price");
    }

    private static void assertEquals(double expected, double actual, String label) {
        if (Double.compare(expected, actual) != 0) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }
}
