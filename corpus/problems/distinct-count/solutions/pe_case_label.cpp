// Mutant (PE): right answers, but in the "Case #k: x" style of other judges,
// which isn't the output format: ncmp finds a word where it expects a number.
#include <bits/stdc++.h>

using namespace std;

int main()
{
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int T;
    cin >> T;
    for (int c = 1; c <= T; c++)
    {
        int n;
        cin >> n;
        vector<int> a(n);
        for (auto &x : a)
            cin >> x;
        sort(a.begin(), a.end());
        cout << "Case #" << c << ": " << unique(a.begin(), a.end()) - a.begin() << '\n';
    }
    return 0;
}
