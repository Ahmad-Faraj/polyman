import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.HashMap;
import java.util.StringTokenizer;

// Mutant (WA) in Java: the single pass is right, but the answer is kept in an
// int, which wraps around once there are more than 2^31 - 1 pairs.
public class wa_int_overflow {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        StringTokenizer tokens = new StringTokenizer(reader.readLine());
        int n = Integer.parseInt(tokens.nextToken());
        int k = Integer.parseInt(tokens.nextToken());
        tokens = new StringTokenizer(reader.readLine());

        HashMap<Integer, Integer> count = new HashMap<>();
        int pairs = 0;
        for (int i = 0; i < n; i++) {
            int r = Integer.parseInt(tokens.nextToken()) % k;
            pairs += count.getOrDefault((k - r) % k, 0);
            count.merge(r, 1, Integer::sum);
        }
        System.out.println(pairs);
    }
}
