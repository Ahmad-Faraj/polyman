// Generator for mean-deviation: gen n maxAbs mode
//   spread  - values in [-maxAbs, maxAbs]
//   cluster - values in [10^6 - 6, 10^6]: a mean near 10^6 with a deviation
//             near 2, where low-precision arithmetic loses the deviation
#include "testlib.h"
#include <cstdio>
#include <cstdlib>
#include <string>

using namespace std;

int main(int argc, char *argv[])
{
    registerGen(argc, argv, 1);

    int n = atoi(argv[1]);
    int m = atoi(argv[2]);
    string mode = argv[3];
    if (mode != "spread" && mode != "cluster")
        quitf(_fail, "unknown mode %s", mode.c_str());

    printf("%d\n", n);
    for (int i = 0; i < n; i++)
    {
        int x = mode == "spread" ? rnd.next(-m, m) : rnd.next(1000000 - 6, 1000000);
        printf("%d%c", x, i + 1 < n ? ' ' : '\n');
    }
}
