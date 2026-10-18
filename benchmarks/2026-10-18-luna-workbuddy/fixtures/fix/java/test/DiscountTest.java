public final class DiscountTest {
    public static void main(String[] args) {
        if (Discount.apply(100, .2) != 80) throw new AssertionError("valid rate");
    }
}
