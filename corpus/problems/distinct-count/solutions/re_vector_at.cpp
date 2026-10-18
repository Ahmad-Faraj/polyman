// Mutant (RE): the reading loop runs one step too far; vector::at throws
// std::out_of_range, which is never caught.
#include <bits/stdc++.h>

using namespace std;

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
        vector<int> a(n);
        for (int i = 0; i <= n; i++)
            cin >> a.at(i);
        sort(a.begin(), a.end());
        cout << unique(a.begin(), a.end()) - a.begin() << '\n';
    }
    return 0;
}
