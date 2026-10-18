import java.io.DataInputStream;
import java.io.IOException;
import java.util.HashMap;

// Correct in Java, with a HashMap of the values seen so far.
public class ok_java {
    private static final DataInputStream in = new DataInputStream(System.in);
    private static final byte[] buffer = new byte[1 << 16];
    private static int length = 0, position = 0;

    private static int read() throws IOException {
        if (position == length) {
            length = in.read(buffer, 0, buffer.length);
            position = 0;
            if (length <= 0) return -1;
        }
        return buffer[position++];
    }

    private static long nextLong() throws IOException {
        int c = read();
        while (c == ' ' || c == '\n' || c == '\r') c = read();
        boolean negative = c == '-';
        if (negative) c = read();
        long value = 0;
        while (c >= '0' && c <= '9') {
            value = value * 10 + (c - '0');
            c = read();
        }
        return negative ? -value : value;
    }

    public static void main(String[] args) throws IOException {
        int n = (int) nextLong();
        long t = nextLong();
        long[] a = new long[n];
        for (int i = 0; i < n; i++) a[i] = nextLong();

        HashMap<Long, Integer> seen = new HashMap<>();
        for (int j = 0; j < n; j++) {
            Integer i = seen.get(t - a[j]);
            if (i != null) {
                System.out.println((i + 1) + " " + (j + 1));
                return;
            }
            seen.putIfAbsent(a[j], j);
        }
        System.out.println(-1);
    }
}
