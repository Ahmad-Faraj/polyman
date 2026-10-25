// Generator for remainder-pairs: gen n k maxV mode
//   random    - values in [1, maxV]
//   multiples - values are multiples of k in [k, maxV], so every pair counts
//               and the answer, n(n-1)/2, does not fit in 32 bits for n = 10^5
#include "testlib.h"
#include <cstdio>
#include <cstdlib>
#include <string>

using namespace std;

int main(int argc, char *argv[])
{
    registerGen(argc, argv, 1);

    int n = atoi(argv[1]);
    long long k = atoll(argv[2]);
    long long maxV = atoll(argv[3]);
    string mode = argv[4];
    if (mode != "random" && mode != "multiples")
        quitf(_fail, "unknown mode %s", mode.c_str());

    printf("%d %lld\n", n, k);
    for (int i = 0; i < n; i++)
    {
        long long x = mode == "random" ? rnd.next(1LL, maxV) : k * rnd.next(1LL, maxV / k);
        printf("%lld%c", x, i + 1 < n ? ' ' : '\n');
    }
}
