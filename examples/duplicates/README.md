# Duplicates

The duplicates example is a harness on switch with one domain, `duplicates`. It finds the items of a list that check
the same thing, such as two criteria of a rubric that ask for one requirement in other words. It never asks about every
pair of items: a list of n items takes n questions in the first step, and two questions for each pair that the first
step names in the second.

The example uses switch only by its package name, `@osolmaz/switch`, as a project outside switch would.

## Cases

A case folder holds a `case.json` with the case's `id` and its `items`, each with an `id` and a `text`. Item ids must
differ, and a list has at least two items:

```json
{
  "id": "toy",
  "items": [
    { "id": "A", "text": "The reply names the deadline of 3 May and the court." },
    { "id": "B", "text": "The reply states the 3 May deadline and names the court." }
  ]
}
```

## The state machine

Each list is a state machine, in [`src/duplicates.ts`](src/duplicates.ts). The model reads the whole list, by item id,
in every step.

1. **Find:** one pick per item. Its choices are the ids of the other items and none, and the model picks the item that
   checks the same thing as this one, in full or in part. Every item that the model gives a probability of at least
   0.25, and the picked one, makes a candidate pair with this item. A pair named from both sides counts once.
2. **Check:** two yes-or-no questions per candidate pair: whether every answer that meets the first item also meets
   the second, and the same the other way. With no candidate, the run ends after the find step.

A pair is a duplicate when each item covers the other with a probability of at least 0.5, an overlap when only one
does, and separate when neither does. The outcome holds every checked pair with both probabilities and its kind, and
the counts of duplicates and overlaps. The texts and the two thresholds are the domain's definition, in `TEXTS`.

A pick takes at most 255 choices, as Jev does, so a list of more than 255 items would cut the choices of each find
question.

## Run

```bash
node --conditions=switch-source examples/duplicates/src/main.ts run --out runs/duplicates cases/*
```

The model is `typesafe/jev-latest` by default, with its key in `TYPESAFE_API_KEY`.
