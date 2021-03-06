import BaseContext from '../context';
import clone from '../utils/clone';
import estraverse from 'estraverse'; // TODO: import { traverse } from 'estraverse';
import replace from '../utils/replace';
import type Module from '../module';

const { Syntax, VisitorOption  } = estraverse;

export const name = 'objects.destructuring';
export const description = 'Transform some declarations and assignments to the more compact destructuring form.';

type DestructuringMetadata = {
  ids: Array<Object>,
  inits: Array<Object>
};

type Metadata = Array<DestructuringMetadata>;

class Context extends BaseContext {
  constructor(module: Module) {
    super(name, module);
    module.metadata[name] = ([]: Metadata);
  }

  rewriteVariableDeclaration(node: Object): boolean {
    if (node.type !== Syntax.VariableDeclaration) {
      return false;
    }

    for (let index = 0; index < node.declarations.length; index++) {
      const elements = this._extractSequentialDestructurableElements(node.declarations, index);
      this._rewriteDestructurableElements(elements);

      if (elements.length !== 0) {
        // Add information about the transformation.
        this.metadata.push({
          ids: elements.map(({ id }) => id),
          inits: elements.map(({ init }) => init)
        });

        // Mutate the AST to reflect the new reality.
        node.declarations.splice(index, elements.length, {
          type: Syntax.VariableDeclarator,
          id: {
            type: Syntax.ObjectPattern,
            properties: elements.map(declarator => ({
              type: Syntax.Property,
              computed: false,
              shorthand: true,
              method: false,
              key: declarator.id,
              value: declarator.id
            }))
          },
          init: elements[0].init.object
        });
      }
    }

    return true;
  }

  _rewriteDestructurableElements(elements: Array<Object>) {
    if (elements.length === 0) {
      return;
    }

    const firstElement = elements[0];

    // `const a = obj.a, b = obj.b;` -> `const { a = obj.a, b = obj.b;`
    //                                         ^^
    this.insert(leftRightOfAssignment(firstElement).left.range[0], '{ ');

    for (let i = 0; i < elements.length - 1; i++) {
      const { left, right } = leftRightOfAssignment(elements[i]);
      // `const { a = obj.a, b = obj.b;` -> `const { a, b = obj.b;`
      //           ^^^^^^^^
      this.remove(left.range[1], right.range[1]);
    }

    const lastElement = elements[elements.length - 1];
    const { left: lastLeft, right: lastRight } = leftRightOfAssignment(lastElement);

    // `const { a, b = obj.b;` -> `const { a, b } = obj.b;`
    //                                         ^^
    this.insert(lastLeft.range[1], ' }');

    // `const { a, b } = obj.b;` -> `const { a, b } = obj;`
    //                      ^^
    this.remove(lastRight.object.range[1], lastRight.range[1]);
  }

  rewriteAssignment(node: Object): boolean {
    const assignments = this._extractSequentialDestructurableElements([node]);

    if (assignments.length === 0) {
      return false;
    }

    if (node.parentNode.type !== Syntax.ExpressionStatement) {
      return false;
    }

    // `a = obj.a;` -> `(a = obj.a);`
    //                  ^         ^
    this.insert(assignments[0].range[0], '(');
    this.insert(assignments[assignments.length - 1].range[1], ')');

    this._rewriteDestructurableElements(assignments);

    // Add information about the transformation.
    this.metadata.push({
      ids: assignments.map(assignment => assignment.left),
      inits: assignments.map(assignment => assignment.right)
    });

    replace(node, {
      type: Syntax.AssignmentExpression,
      operator: '=',
      left: {
        type: Syntax.ObjectPattern,
        properties: assignments.map(assignment => ({
          type: Syntax.Property,
          computed: false,
          shorthand: true,
          method: false,
          key: {
            type: Syntax.Identifier,
            name: assignment.left.name
          },
          value: {
            type: Syntax.Identifier,
            name: assignment.left.name
          }
        }))
      },
      right: node.right.object
    });

    return true;
  }

  rewriteSequenceExpression(node: Object): boolean {
    if (node.type !== Syntax.SequenceExpression) {
      return false;
    }

    const { expressions } = node;

    for (let index = 0; index < expressions.length; index++) {
      const assignments = this._extractSequentialDestructurableElements(expressions, index);

      if (assignments.length > 0 && index === 0) {
        // `a = obj.a;` -> `(a = obj.a);`
        this.insert(assignments[0].range[0], '(');
        this.insert(assignments[assignments.length - 1].range[1], ')');
      }

      if (assignments.length > 0) {
        this._rewriteDestructurableElements(assignments);

        this.metadata.push({
          ids: assignments.map(assignment => assignment.left),
          inits: assignments.map(assignment => assignment.right)
        });

        expressions.splice(index, assignments.length, {
          type: Syntax.AssignmentExpression,
          operator: '=',
          left: {
            type: Syntax.ObjectPattern,
            properties: assignments.map(({ left }) => ({
              type: Syntax.Property,
              computed: false,
              method: false,
              shorthand: true,
              key: left,
              value: left
            }))
          },
          right: assignments[0].right.object
        });
      }
    }

    if (expressions.length === 1) {
      replace(node, expressions[0]);
    }

    return true;
  }

  _extractSequentialDestructurableElements(elements: Array<Object>, start=0): Array<Object> {
    const result = [];
    let objectSource;

    for (let i = start; i < elements.length; i++) {
      const element = elements[i];
      const { left, right } = leftRightOfAssignment(element) || {};

      if (!left || left.type !== Syntax.Identifier) {
        break;
      }

      if (!right || right.type !== Syntax.MemberExpression) {
        break;
      }

      if (right.computed) {
        break;
      }

      if (left.name !== right.property.name) {
        break;
      }

      const thisObjectSource = this.module.sourceOf(right.object);
      if (!objectSource) {
        objectSource = thisObjectSource;
      } else if (objectSource !== thisObjectSource) {
        break;
      }

      result.push(clone(element));

      if (!isSafeToConsolidate(right.object)) {
        break;
      }
    }

    return result;
  }
}

function leftRightOfAssignment(node: Object): ?{ left: Object, right: Object } {
  switch (node.type) {
    case Syntax.VariableDeclarator:
      return { left: node.id, right: node.init };

    case Syntax.AssignmentExpression:
      if (node.operator === '=') {
        return { left: node.left, right: node.right };
      }
      break;
  }

  return null;
}

export function begin(module: Module): Context {
  return new Context(module);
}

export function enter(node: Object, module: Module, context: Context): ?VisitorOption {
  context.rewriteVariableDeclaration(node) || context.rewriteSequenceExpression(node) || context.rewriteAssignment(node);
  return null;
}

function isSafeToConsolidate(node: Object): boolean {
  return node.type === Syntax.Identifier;
}
