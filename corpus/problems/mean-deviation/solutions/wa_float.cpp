// Mutant (WA): the same two passes as the main solution, but in float, whose
// 24-bit mantissa can't hold sums of large values or small deviations precisely.
#include <bits/stdc++.h>

using namespace std;

int main()
{
    int n;
    scanf("%d", &n);
    vector<float> x(n);
    float sum = 0;
    for (auto &v : x)
    {
        int value;
        scanf("%d", &value);
        v = value;
        sum += v;
    }
    float mean = sum / n;
    float squares = 0;
    for (float v : x)
        squares += (v - mean) * (v - mean);
    printf("%.9f %.9f\n", mean, sqrtf(squares / n));
    return 0;
}
