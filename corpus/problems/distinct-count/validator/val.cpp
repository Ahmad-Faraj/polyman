#include "testlib.h"

using namespace std;

int main(int argc, char *argv[])
{
    registerValidation(argc, argv);

    int testCaseCount = inf.readInt(1, 10000, "T");
    inf.readEoln();
    long long total = 0;

    for (int testCase = 1; testCase <= testCaseCount; testCase++)
    {
        setTestCase(testCase);

        int n = inf.readInt(1, 200000, "n");
        inf.readEoln();
        total += n;
        ensuref(total <= 200000, "the sum of n exceeds 200000");
        for (int i = 0; i < n; i++)
        {
            inf.readInt(1, 1000000000, "a_i");
            if (i < n - 1)
                inf.readSpace();
        }
        inf.readEoln();
    }
    inf.readEof();
}
