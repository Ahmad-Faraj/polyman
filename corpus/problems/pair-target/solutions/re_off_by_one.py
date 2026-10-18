# Mutant (RE) in Python: numbers the positions from 1 while the list starts at
# 0, so building the index reads one past the end of the list (IndexError).
n, t = map(int, input().split())
a = list(map(int, input().split()))

first = {}
for i in range(1, n + 1):
    first.setdefault(a[i], i)

for j in range(1, n + 1):
    i = first.get(t - a[j - 1])
    if i is not None and i != j:
        print(i, j)
        break
else:
    print(-1)
