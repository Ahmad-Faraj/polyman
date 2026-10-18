// Correct, in one pass: the sums of the values and of their squares are exact
// integers, so n^2 * variance = n * sum(x^2) - (sum x)^2 has no rounding error.
#include <bits/stdc++.h>

using namespace std;

int main()
{
    int n;
    scanf("%d", &n);
    long long sum = 0;
    __int128 squares = 0;
    for (int i = 0; i < n; i++)
    {
        long long v;
        scanf("%lld", &v);
        sum += v;
        squares += (__int128)v * v;
    }
    __int128 scaled = (__int128)n * squares - (__int128)sum * sum;
    long double variance = (long double)scaled / ((long double)n * n);
    printf("%.10Lf %.10Lf\n", (long double)sum / n, sqrtl(variance));
    return 0;
}
