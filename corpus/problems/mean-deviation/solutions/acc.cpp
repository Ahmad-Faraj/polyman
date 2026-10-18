// Main solution: two passes in long double, the mean first, then the squared
// differences from it.
#include <bits/stdc++.h>

using namespace std;

int main()
{
    int n;
    scanf("%d", &n);
    vector<long long> x(n);
    long long sum = 0;
    for (auto &v : x)
    {
        scanf("%lld", &v);
        sum += v;
    }
    long double mean = (long double)sum / n;
    long double squares = 0;
    for (long long v : x)
        squares += (v - mean) * (v - mean);
    printf("%.9Lf %.9Lf\n", mean, sqrtl(squares / n));
    return 0;
}
