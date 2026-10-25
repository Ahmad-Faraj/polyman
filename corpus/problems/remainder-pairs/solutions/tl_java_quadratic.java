import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.StringTokenizer;

// Mutant (TL) in Java: right answers, but it checks every pair, about
// 5 * 10^9 steps for n = 10^5, many times over the time limit.
public class tl_java_quadratic {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        StringTokenizer tokens = new StringTokenizer(reader.readLine());
        int n = Integer.parseInt(tokens.nextToken());
        long k = Long.parseLong(tokens.nextToken());
        tokens = new StringTokenizer(reader.readLine());
        long[] a = new long[n];
        for (int i = 0; i < n; i++) a[i] = Long.parseLong(tokens.nextToken());

        long pairs = 0;
        for (int i = 0; i < n; i++)
            for (int j = i + 1; j < n; j++)
                if ((a[i] + a[j]) % k == 0) pairs++;
        System.out.println(pairs);
    }
}
