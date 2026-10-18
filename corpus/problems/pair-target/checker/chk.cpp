/*
Checker for pair-target. Any two different positions whose values add up to t
are accepted, so the participant's pair is checked against the input instead
of being compared with the jury's.
- "-1" while the jury found a pair: WA.
- A pair while the jury printed -1: FAIL (the jury's solution is wrong).
- The same position twice, a position out of range, or a wrong sum: WA.
- Something that isn't an integer, a missing second position, or extra output: PE.
*/
#include "testlib.h"
#include <vector>

using namespace std;

int n;
long long t;
vector<long long> a;

// Reads "-1" or "i j" and checks the pair; returns false for -1. On the answer
// stream every failure is the jury's, and testlib reports it as FAIL.
bool readPair(InStream &s, int &i, int &j)
{
    i = s.readInt(-1, n, "i");
    if (i == -1)
        return false;
    if (i == 0)
        s.quitf(_wa, "position 0 does not exist");
    j = s.readInt(1, n, "j");
    if (i == j)
        s.quitf(_wa, "the two positions must differ, both are %d", i);
    if (a[i - 1] + a[j - 1] != t)
        s.quitf(_wa, "a[%d] + a[%d] = %lld, not %lld", i, j, a[i - 1] + a[j - 1], t);
    return true;
}

int main(int argc, char *argv[])
{
    registerTestlibCmd(argc, argv);

    n = inf.readInt();
    t = inf.readLong();
    a.resize(n);
    for (auto &x : a)
        x = inf.readLong();

    int ji = 0, jj = 0, pi = 0, pj = 0;
    bool jury = readPair(ans, ji, jj);
    bool participant = readPair(ouf, pi, pj);

    if (participant && !jury)
        quitf(_fail, "the participant found a pair (%d, %d), the jury printed -1", pi, pj);
    if (!participant && jury)
        quitf(_wa, "a pair exists, for example (%d, %d), but -1 was printed", ji, jj);
    if (participant)
        quitf(_ok, "a[%d] + a[%d] = %lld", pi, pj, t);
    quitf(_ok, "no pair exists");
}
