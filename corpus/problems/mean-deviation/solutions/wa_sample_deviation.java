import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.Locale;
import java.util.StringTokenizer;

// Mutant (WA) in Java: the sample standard deviation, dividing by n - 1
// instead of n as the statement says.
public class wa_sample_deviation {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        int n = Integer.parseInt(reader.readLine().trim());
        StringTokenizer tokens = new StringTokenizer(reader.readLine());
        long[] x = new long[n];
        long sum = 0;
        for (int i = 0; i < n; i++) {
            x[i] = Long.parseLong(tokens.nextToken());
            sum += x[i];
        }
        double mean = (double) sum / n;
        double squares = 0;
        for (long v : x) squares += (v - mean) * (v - mean);
        System.out.println(String.format(Locale.ROOT, "%.9f %.9f", mean, Math.sqrt(squares / (n - 1))));
    }
}
