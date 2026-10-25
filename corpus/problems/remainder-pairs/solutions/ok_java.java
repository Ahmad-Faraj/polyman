import java.io.DataInputStream;
import java.io.IOException;
import java.util.HashMap;

// Correct in Java: the same single pass as the main solution, with a fast reader,
// well inside the time limit including the JVM's start.
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
        long value = 0;
        while (c >= '0' && c <= '9') {
            value = value * 10 + (c - '0');
            c = read();
        }
        return value;
    }

    public static void main(String[] args) throws IOException {
        int n = (int) nextLong();
        long k = nextLong();
        HashMap<Long, Long> count = new HashMap<>();
        long pairs = 0;
        for (int i = 0; i < n; i++) {
            long r = nextLong() % k;
            pairs += count.getOrDefault((k - r) % k, 0L);
            count.merge(r, 1L, Long::sum);
        }
        System.out.println(pairs);
    }
}
