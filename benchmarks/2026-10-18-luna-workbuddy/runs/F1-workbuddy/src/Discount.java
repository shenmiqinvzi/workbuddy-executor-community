public final class Discount {
    private Discount() {}

    /**
     * Applies a discount rate to a price.
     *
     * <p>The rate is clamped into [0, 1]. A NaN rate is treated as "no discount"
     * and the original price is returned unchanged. The returned amount is never
     * negative: non-positive prices yield 0.</p>
     *
     * @param price original price
     * @param rate  discount rate, clamped to [0, 1]
     * @return discounted amount, never negative
     */
    public static double apply(double price, double rate) {
        if (Double.isNaN(rate)) {
            return price;
        }
        double clampedRate = Math.max(0.0, Math.min(1.0, rate));
        double amount = price * (1.0 - clampedRate);
        if (Double.isNaN(amount)) {
            return amount;
        }
        // Covers negatives and negative zero, which would otherwise surface as -0.0.
        if (amount <= 0.0) {
            return 0.0;
        }
        return amount;
    }
}
