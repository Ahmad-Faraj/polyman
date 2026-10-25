// Generator for distinct-count: gen T maxN maxV
// T test cases; each has n in [1, maxN] values in [1, maxV]. The sum of n
// stays within 2 * 10^5: every case leaves room for one value per later case.
#include "testlib.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>

using namespace std;

int main(int argc, char *argv[])
{
    registerGen(argc, argv, 1);

    int T = atoi(argv[1]);
    int maxN = atoi(argv[2]);
    int maxV = atoi(argv[3]);
    long long budget = 200000;

    printf("%d\n", T);
    for (int c = 0; c < T; c++)
    {
        long long room = budget - (T - c - 1);
        int n = rnd.next(1, (int)min<long long>(maxN, room));
        budget -= n;
        printf("%d\n", n);
        for (int i = 0; i < n; i++)
            printf("%d%c", rnd.next(1, maxV), i + 1 < n ? ' ' : '\n');
    }
}
