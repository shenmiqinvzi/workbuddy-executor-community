public final class Discount {
    private Discount() {}
    public static double apply(double price, double rate) {
        return price * (1.0 - rate);
    }
}
