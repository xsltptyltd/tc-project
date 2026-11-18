// A stand-in for the DynamoDB document client, just big enough for DynamoStore: one
// table held in memory, and the commands and expression forms the store uses. It is
// strict on purpose: an expression it does not understand throws, so a change in the
// store that this stand-in cannot check fails loudly instead of passing unchecked.
//
// It keeps the DynamoDB behaviours that matter for correctness:
//   - a query returns pages, and the filter is applied after the page is cut;
//   - a failed condition throws ConditionalCheckFailedException — on a put, an update or
//     a delete;
//   - reserved words are refused unless written as #names;
//   - a transaction writes everything or nothing: if any condition fails, it throws
//     TransactionCanceledException with one reason per item, as DynamoDB does, and
//     writes nothing; it refuses two writes to the same item, as DynamoDB does.
type Item = Record<string, unknown>;
type Values = Record<string, unknown> | undefined;
type Names = Record<string, string> | undefined;

// Some of DynamoDB's reserved words — the ones this table's attributes come close to.
const RESERVED = new Set([
  'from', 'to', 'ttl', 'name', 'status', 'key', 'value', 'type', 'data', 'timestamp',
  'owner', 'connection', 'user', 'date', 'time', 'count', 'size',
]);

class ConditionalCheckFailed extends Error {
  override name = 'ConditionalCheckFailedException';
}

class TransactionCanceled extends Error {
  override name = 'TransactionCanceledException';
  constructor(readonly CancellationReasons: Array<{ Code: string }>) {
    super(`Transaction cancelled, please refer cancellation reasons for specific reasons [${CancellationReasons.map((r) => r.Code).join(', ')}]`);
  }
}

function operand(token: string, item: Item | undefined, names: Names, values: Values): unknown {
  if (token.startsWith(':')) {
    if (!values || !(token in values)) throw new Error(`fake DynamoDB: no value for ${token}`);
    return values[token];
  }
  return item?.[attribute(token, names)];
}

function attribute(token: string, names: Names): string {
  if (token.startsWith('#')) {
    const name = names?.[token];
    if (!name) throw new Error(`fake DynamoDB: no name for ${token}`);
    return name;
  }
  if (RESERVED.has(token.toLowerCase())) {
    throw new Error(`fake DynamoDB: "${token}" is a reserved word, use an expression attribute name`);
  }
  return token;
}

/** Clauses joined by AND; each one a comparison or one of three functions. */
function matches(expression: string | undefined, item: Item | undefined, names: Names, values: Values): boolean {
  if (!expression) return true;
  return expression.split(/\s+AND\s+/).every((clause) => {
    let m: RegExpMatchArray | null;
    // Names are resolved before looking at the item: DynamoDB refuses a bad expression
    // whether or not the item exists.
    if ((m = clause.match(/^attribute_exists\(([#\w]+)\)$/))) {
      const name = attribute(m[1]!, names);
      return item !== undefined && name in item;
    }
    if ((m = clause.match(/^attribute_not_exists\(([#\w]+)\)$/))) {
      const name = attribute(m[1]!, names);
      return item === undefined || !(name in item);
    }
    if ((m = clause.match(/^begins_with\(([#\w]+),\s*(:\w+)\)$/))) {
      const value = operand(m[1]!, item, names, values);
      return typeof value === 'string' && value.startsWith(String(operand(m[2]!, item, names, values)));
    }
    if ((m = clause.match(/^([#\w]+)\s*(=|>)\s*(:\w+)$/))) {
      const left = operand(m[1]!, item, names, values);
      const right = operand(m[3]!, item, names, values);
      return m[2] === '=' ? left === right : (left as number) > (right as number);
    }
    throw new Error(`fake DynamoDB: cannot evaluate "${clause}"`);
  });
}

const keyOf = (key: Item) => `${String(key.PK)}|${String(key.SK)}`;

export class FakeDynamoDB {
  readonly items = new Map<string, Item>();
  /** Commands received, by name, for tests that care how something was done. */
  readonly calls: string[] = [];

  /** @param pageSize how many items a query looks at per page; small, to exercise paging */
  constructor(private readonly pageSize = 2) {}

  async send(command: { constructor: { name: string }; input: any }): Promise<any> {
    const { input } = command;
    this.calls.push(command.constructor.name);
    switch (command.constructor.name) {
      case 'PutCommand':
        this.check({ ...input, Key: input.Item });
        this.items.set(keyOf(input.Item), { ...input.Item });
        return {};
      case 'GetCommand': {
        const item = this.items.get(keyOf(input.Key));
        return { Item: item && { ...item } };
      }
      case 'DeleteCommand':
        this.check(input);
        this.items.delete(keyOf(input.Key));
        return {};
      case 'UpdateCommand':
        this.check(input);
        this.update(input);
        return {};
      case 'TransactWriteCommand': {
        const writes: Array<{ kind: string; input: any; key: Item }> = input.TransactItems.map((t: any) => {
          const [kind, write] = Object.entries(t)[0] as [string, any];
          if (!['Put', 'Update', 'Delete'].includes(kind)) throw new Error(`fake DynamoDB: unsupported transaction item ${kind}`);
          return { kind, input: write, key: kind === 'Put' ? write.Item : write.Key };
        });
        const keys = writes.map((w) => keyOf(w.key));
        if (new Set(keys).size !== keys.length) {
          throw Object.assign(new Error('Transaction request cannot include multiple operations on one item'), {
            name: 'ValidationException',
          });
        }
        // Every condition is checked before anything is written; one failure cancels all.
        const reasons = writes.map((w) => {
          try {
            this.check({ ...w.input, Key: w.key });
            return { Code: 'None' };
          } catch (error) {
            if (error instanceof ConditionalCheckFailed) return { Code: 'ConditionalCheckFailed' };
            throw error;
          }
        });
        if (reasons.some((r) => r.Code !== 'None')) throw new TransactionCanceled(reasons);
        for (const w of writes) {
          if (w.kind === 'Put') this.items.set(keyOf(w.key), { ...w.input.Item });
          else if (w.kind === 'Update') this.update(w.input);
          else this.items.delete(keyOf(w.key));
        }
        return {};
      }
      case 'QueryCommand':
        return this.query(input);
      default:
        throw new Error(`fake DynamoDB: unsupported command ${command.constructor.name}`);
    }
  }

  /** `SET a = :x` or `SET #a = :x, #b = :y`: all this store writes. */
  private update(input: any): void {
    const expression = String(input.UpdateExpression);
    const body = expression.match(/^SET (.+)$/)?.[1];
    if (!body) throw new Error(`fake DynamoDB: cannot evaluate "${expression}"`);
    const existing = this.items.get(keyOf(input.Key)) ?? { ...input.Key };
    for (const assignment of body.split(/,\s*/)) {
      const set = assignment.match(/^([#\w]+) = (:\w+)$/);
      if (!set) throw new Error(`fake DynamoDB: cannot evaluate "${expression}"`);
      const name = attribute(set[1]!, input.ExpressionAttributeNames);
      if (!(set[2]! in (input.ExpressionAttributeValues ?? {}))) throw new Error(`fake DynamoDB: no value for ${set[2]}`);
      existing[name] = input.ExpressionAttributeValues[set[2]!];
    }
    this.items.set(keyOf(input.Key), existing);
  }

  private check(input: any): void {
    const item = this.items.get(keyOf(input.Key));
    if (!matches(input.ConditionExpression, item, input.ExpressionAttributeNames, input.ExpressionAttributeValues)) {
      throw new ConditionalCheckFailed('The conditional request failed');
    }
  }

  private query(input: any): { Items: Item[]; LastEvaluatedKey?: Item } {
    if (input.IndexName && input.ConsistentRead) {
      throw new Error('fake DynamoDB: a global secondary index cannot be read consistently');
    }
    const names = input.ExpressionAttributeNames;
    const values = input.ExpressionAttributeValues;
    const inKey = [...this.items.values()]
      .filter((item) => matches(input.KeyConditionExpression, item, names, values))
      .sort((a, b) => (String(a.SK) < String(b.SK) ? -1 : 1));
    const start = input.ExclusiveStartKey
      ? inKey.findIndex((item) => keyOf(item) === keyOf(input.ExclusiveStartKey)) + 1
      : 0;
    const page = inKey.slice(start, start + this.pageSize);
    const more = start + this.pageSize < inKey.length;
    const last = page[page.length - 1];
    const projected = (item: Item): Item =>
      input.ProjectionExpression
        ? Object.fromEntries(
            String(input.ProjectionExpression)
              .split(/,\s*/)
              .map((token) => attribute(token, names))
              .filter((name) => name in item)
              .map((name) => [name, item[name]]),
          )
        : { ...item };
    return {
      // Like DynamoDB: the filter runs after the page is cut, so a page can come back
      // short, or empty, while more pages remain.
      Items: page.filter((item) => matches(input.FilterExpression, item, names, values)).map(projected),
      ...(more && last && { LastEvaluatedKey: { PK: last.PK, SK: last.SK } }),
    };
  }
}
