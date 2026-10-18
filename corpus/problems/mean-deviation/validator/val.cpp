#include "testlib.h"

using namespace std;

int main(int argc, char *argv[])
{
    registerValidation(argc, argv);

    int n = inf.readInt(2, 100000, "n");
    inf.readEoln();
    for (int i = 0; i < n; i++)
    {
        inf.readInt(-1000000, 1000000, "x_i");
        if (i < n - 1)
            inf.readSpace();
    }
    inf.readEoln();
    inf.readEof();
}
