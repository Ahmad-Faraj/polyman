#include "testlib.h"

using namespace std;

int main(int argc, char *argv[])
{
    registerValidation(argc, argv);

    int n = inf.readInt(2, 100000, "n");
    inf.readSpace();
    inf.readLong(-2000000000LL, 2000000000LL, "t");
    inf.readEoln();
    for (int i = 0; i < n; i++)
    {
        inf.readInt(-1000000000, 1000000000, "a_i");
        if (i < n - 1)
            inf.readSpace();
    }
    inf.readEoln();
    inf.readEof();
}
