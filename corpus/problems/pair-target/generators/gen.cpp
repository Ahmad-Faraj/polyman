// Generator for pair-target: gen n maxAbs mode
//   yes   - random values in [-maxAbs, maxAbs]; t is the sum of two random different positions
//   no    - every value is even and t is odd, so no pair exists
//   twice - every value is a multiple of 3 except one, x = 1 (mod 3), and t = 2x:
//           only x + x reaches t, which uses one position twice, so the answer is -1
//   many  - values in [1, maxAbs] (keep it small); t is the sum of two random positions
#include "testlib.h"
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

using namespace std;

int main(int argc, char *argv[])
{
    registerGen(argc, argv, 1);

    int n = atoi(argv[1]);
    long long m = atoll(argv[2]);
    string mode = argv[3];

    vector<long long> a(n);
    long long t = 0;

    if (mode == "yes" || mode == "many")
    {
        long long low = mode == "many" ? 1 : -m;
        for (auto &x : a)
            x = rnd.next(low, m);
        int i = rnd.next(0, n - 1);
        int j = rnd.next(0, n - 2);
        if (j >= i)
            j++;
        t = a[i] + a[j];
    }
    else if (mode == "no")
    {
        for (auto &x : a)
            x = 2 * rnd.next(-m / 2, m / 2);
        t = 2 * rnd.next(-m / 2, m / 2) + 1;
    }
    else if (mode == "twice")
    {
        for (auto &x : a)
            x = 3 * rnd.next(-m / 3, m / 3);
        int k = rnd.next(0, n - 1);
        a[k] = 3 * rnd.next(-(m - 1) / 3, (m - 1) / 3) + 1;
        t = 2 * a[k];
    }
    else
    {
        quitf(_fail, "unknown mode %s", mode.c_str());
    }

    printf("%d %lld\n", n, t);
    for (int i = 0; i < n; i++)
        printf("%lld%c", a[i], i + 1 < n ? ' ' : '\n');
}
