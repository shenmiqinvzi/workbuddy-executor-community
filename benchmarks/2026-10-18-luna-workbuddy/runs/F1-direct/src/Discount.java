public final class Discount {
    private Discount() {}
    public static double apply(double price, double rate) {
        if (Double.isNaN(rate)) {
            return Math.max(0.0, price);
        }
        double clampedRate = Math.max(0.0, Math.min(1.0, rate));
        return Math.max(0.0, price * (1.0 - clampedRate));
    }
}
