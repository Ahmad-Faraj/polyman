// Mutant (WA): the set of values is global and never cleared between test
// cases, so from the second test case on it counts earlier cases' values too.
#include <bits/stdc++.h>

using namespace std;

set<int> values;

int main()
{
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int T;
    cin >> T;
    while (T--)
    {
        int n;
        cin >> n;
        for (int i = 0; i < n; i++)
        {
            int x;
            cin >> x;
            values.insert(x);
        }
        cout << values.size() << '\n';
    }
    return 0;
}
