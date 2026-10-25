import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.HashSet;
import java.util.StringTokenizer;

// Correct in Java: a HashSet per test case, one line of output per case.
public class ok_java {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        int cases = Integer.parseInt(reader.readLine().trim());
        StringBuilder out = new StringBuilder();
        for (int c = 0; c < cases; c++) {
            int n = Integer.parseInt(reader.readLine().trim());
            StringTokenizer tokens = new StringTokenizer(reader.readLine());
            HashSet<Integer> values = new HashSet<>();
            for (int i = 0; i < n; i++) values.add(Integer.parseInt(tokens.nextToken()));
            out.append(values.size()).append('\n');
        }
        System.out.print(out);
    }
}
