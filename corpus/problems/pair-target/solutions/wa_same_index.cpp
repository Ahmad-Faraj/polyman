// Mutant (WA): stores every value first and then looks up t - a[i] without
// checking that the match is another position, so for t = 2 a[i] it may answer "i i".
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
    map<long long, int> where;
    for (int i = 0; i < n; i++)
    {
        cin >> a[i];
        where[a[i]] = i;
    }

    for (int i = 0; i < n; i++)
    {
        auto it = where.find(t - a[i]);
        if (it != where.end())
        {
            cout << i + 1 << ' ' << it->second + 1 << '\n';
            return 0;
        }
    }
    cout << -1 << '\n';
    return 0;
}
