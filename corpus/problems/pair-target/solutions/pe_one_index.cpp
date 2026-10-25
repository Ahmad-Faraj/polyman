// Mutant (PE): finds the right pair but prints only its second position, so
// the checker runs out of output where it expects the other one.
#include <bits/stdc++.h>

using namespace std;

int main()
{
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    long long t;
    cin >> n >> t;
    vector<long long> a(n);
    for (auto &x : a)
        cin >> x;

    map<long long, int> seen;
    for (int j = 0; j < n; j++)
    {
        if (seen.count(t - a[j]))
        {
            cout << j + 1 << '\n';
            return 0;
        }
        seen.emplace(a[j], j);
    }
    cout << -1 << '\n';
    return 0;
}
