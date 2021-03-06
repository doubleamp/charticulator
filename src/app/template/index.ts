/**
 * The {@link ChartTemplateBuilder} creates tempate ({@link ChartTemplate}) from the current chart.
 * {@link ChartTemplate} contains simplified version of {@link Chart} object in {@link ChartTemplate.specification} property.
 * Tempate can be exported as *.tmplt file (JSON format). It also uses on export to HTML file or on export as Power BI visual.
 *
 * Template can be loaded into container outside of Charticulator app to visualize with custom dataset.
 *
 * @packageDocumentation
 * @preferred
 */

// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import {
  Dataset,
  deepClone,
  Expression,
  getByName,
  Prototypes,
  Specification
} from "../../core";

export interface ExportTemplateTargetProperty {
  displayName: string;
  name: string;
  type: string;
  default: any;
}

/** Represents target chart template export format */
export interface ExportTemplateTarget {
  /** Get export format properties, such as template name, author */
  getProperties(): ExportTemplateTargetProperty[];
  /** Get the file name of the exported artifact */
  getFileName?(properties: { [name: string]: any }): string;
  /** Deprecated: get the file extension of the exported artifact */
  getFileExtension?(properties: { [name: string]: any }): string;
  /** Generate the exported template, return a base64 string encoding the file */
  generate(properties: { [name: string]: any }): Promise<string>;
}

/** Class builds the template from given {@link Specification.Chart} object  */
export class ChartTemplateBuilder {
  protected template: Specification.Template.ChartTemplate;
  protected tableColumns: { [name: string]: Set<string> };
  private objectVisited: { [id: string]: boolean };

  constructor(
    public readonly chart: Specification.Chart,
    public readonly dataset: Dataset.Dataset,
    public readonly manager: Prototypes.ChartStateManager
  ) {}

  public reset() {
    this.template = {
      specification: deepClone(this.chart),
      defaultAttributes: {},
      tables: [],
      inference: [],
      properties: []
    };
    this.tableColumns = {};
    this.objectVisited = {};
  }

  public addTable(table: string) {
    if (!this.tableColumns.hasOwnProperty(table)) {
      this.tableColumns[table] = new Set();
    }
  }

  public addColumn(table: string, column: string) {
    if (table == null) {
      table = this.dataset.tables[0].name;
    }
    const tableObject = getByName(this.dataset.tables, table);
    if (tableObject) {
      if (getByName(tableObject.columns, column)) {
        if (this.tableColumns.hasOwnProperty(table)) {
          this.tableColumns[table].add(column);
        } else {
          this.tableColumns[table] = new Set([column]);
        }
      }
    }
  }

  public addColumnsFromExpression(
    table: string,
    expr: string,
    textExpression?: boolean
  ) {
    if (expr) {
      let ex: Expression.Expression | Expression.TextExpression;
      if (textExpression) {
        ex = Expression.parseTextExpression(expr);
      } else {
        ex = Expression.parse(expr);
      }
      ex.replace((e: Expression.Expression) => {
        if (e instanceof Expression.Variable) {
          this.addColumn(table, e.name);
        }
      });
    }
  }

  public propertyToString(property: Specification.Template.PropertyField) {
    let pn: string;
    if (typeof property == "string" || typeof property == "number") {
      pn = property.toString();
    } else {
      pn = property.property;
      if (property.field) {
        if (
          typeof property.field == "string" ||
          typeof property.field == "number"
        ) {
          pn += "." + property.field.toString();
        } else {
          pn += "." + property.field.join(".");
        }
      }
      if (property.subfield) {
        if (
          typeof property.subfield == "string" ||
          typeof property.subfield == "number"
        ) {
          pn += "." + property.subfield.toString();
        } else {
          pn += "." + property.subfield.join(".");
        }
      }
    }
    return pn;
  }

  public addObject(table: string, objectClass: Prototypes.ObjectClass) {
    // Visit a object only once
    if (this.objectVisited[objectClass.object._id]) {
      return;
    }
    this.objectVisited[objectClass.object._id] = true;

    const template = this.template;

    // Get template inference data
    const params = objectClass.getTemplateParameters();
    if (params && params.inferences) {
      for (const inference of params.inferences) {
        if (inference.axis) {
          this.addColumnsFromExpression(
            inference.dataSource.table,
            inference.axis.expression
          );
        }
        if (inference.scale) {
          // Find all objects that use the scale
          const expressions = new Set<string>();
          let table: string = null;
          let groupBy: Specification.Types.GroupBy = null;
          for (const item of Prototypes.forEachObject(
            this.template.specification
          )) {
            for (const [, mapping] of Prototypes.forEachMapping(
              item.object.mappings
            )) {
              if (mapping.type == "scale") {
                const scaleMapping = mapping as Specification.ScaleMapping;
                if (scaleMapping.scale == inference.objectID) {
                  expressions.add(scaleMapping.expression);
                  if (item.kind == "glyph" || item.kind == "mark") {
                    table = item.glyph.table;
                    // Find the plot segment
                    for (const ps of Prototypes.forEachObject(
                      this.template.specification
                    )) {
                      if (
                        ps.kind == "chart-element" &&
                        Prototypes.isType(ps.object.classID, "plot-segment") &&
                        item.glyph._id === (ps.chartElement as any).glyph
                      ) {
                        groupBy = (ps.chartElement as Specification.PlotSegment)
                          .groupBy;
                        break; // TODO: for now, we assume it's the first one
                      }
                    }
                  }
                  if (
                    item.kind == "chart-element" &&
                    Prototypes.isType(item.chartElement.classID, "links")
                  ) {
                    const linkTable = item.object.properties.linkTable as any;
                    const defaultTable = this.dataset.tables[0];
                    table = (linkTable && linkTable.table) || defaultTable.name;
                  }
                }
              }
            }
          }
          if (expressions.size == 0) {
            // Scale not used
            continue;
          }
          inference.scale.expressions = Array.from(expressions);
          if (!inference.dataSource) {
            inference.dataSource = {
              table,
              groupBy
            };
          }
        }
        if (inference.expression) {
          this.addColumnsFromExpression(
            inference.dataSource.table,
            inference.expression.expression
          );
        }
        if (inference.nestedChart) {
          const { nestedChart } = inference;
          Object.keys(nestedChart.columnNameMap).forEach(key => {
            this.addColumn(inference.dataSource.table, key);
          });
        }
        if (inference.axis) {
          const templateObject = Prototypes.findObjectById(
            this.chart,
            inference.objectID
          );
          const keyDisableAutoMin = `${inference.axis.property}DisableAutoMin`;
          const keyDisableAutoMax = `${inference.axis.property}DisableAutoMax`;

          inference.disableAutoMax = templateObject.properties[
            keyDisableAutoMax
          ] as boolean;
          inference.disableAutoMin = templateObject.properties[
            keyDisableAutoMin
          ] as boolean;

          if (inference.disableAutoMax === undefined) {
            inference.disableAutoMax = false;
          }
          if (inference.disableAutoMin === undefined) {
            inference.disableAutoMin = false;
          }
        }
        template.inference.push(inference);
      }
    }
    if (params && params.properties) {
      for (const property of params.properties) {
        // Make a default display name
        let pn = "";
        if (property.target.property) {
          pn = this.propertyToString(property.target.property);
        } else if (property.target.attribute) {
          pn = property.target.attribute;
        }
        property.displayName = objectClass.object.properties.name + "/" + pn;
        template.properties.push(property);
      }
    }

    // Add filter
    const plotSegmentObj = objectClass.object as Specification.PlotSegment<any>;
    if (Prototypes.isType(plotSegmentObj.classID, "plot-segment")) {
      this.addTable(plotSegmentObj.table);
      const filter = plotSegmentObj.filter;
      if (filter) {
        const { categories, expression } = filter;
        if (expression) {
          this.addColumnsFromExpression(table, expression);
        }
        if (categories) {
          this.addColumnsFromExpression(table, categories.expression);
        }
      }

      const groupBy = plotSegmentObj.groupBy;
      if (groupBy && groupBy.expression) {
        this.addColumnsFromExpression(table, groupBy.expression);
      }
    }

    // Get mappings
    for (const [, mapping] of Prototypes.forEachMapping(
      objectClass.object.mappings
    )) {
      if (mapping.type == "scale") {
        const scaleMapping = mapping as Specification.ScaleMapping;
        this.addColumnsFromExpression(
          scaleMapping.table,
          scaleMapping.expression
        );
      }
      if (mapping.type == "text") {
        const textMapping = mapping as Specification.TextMapping;
        this.addColumnsFromExpression(
          textMapping.table,
          textMapping.textExpression,
          true
        );
      }
    }
  }

  public build(): Specification.Template.ChartTemplate {
    this.reset();

    const template = this.template;

    for (const elementClass of this.manager.getElements()) {
      let table = null;
      if (Prototypes.isType(elementClass.object.classID, "plot-segment")) {
        const plotSegment = elementClass.object as Specification.PlotSegment;
        table = plotSegment.table;
      }
      if (Prototypes.isType(elementClass.object.classID, "links")) {
        const linkTable = elementClass.object.properties
          .linkTable as Specification.AttributeMap;
        if (linkTable) {
          const linksTableName = linkTable.table as string;
          this.addTable(linksTableName); // TODO get table by type
          const linksTable = this.dataset.tables.find(
            table => table.name === linksTableName
          );
          linksTable.columns.forEach(linksColumn =>
            this.addColumn(linksTableName, linksColumn.name)
          );
          const table = this.dataset.tables[0];
          const idColumn =
            table && table.columns.find(column => column.name === "id");
          if (idColumn) {
            this.addColumn(table.name, idColumn.name);
          }
        }
      }
      this.addObject(table, elementClass);
      if (Prototypes.isType(elementClass.object.classID, "plot-segment")) {
        const plotSegmentState = elementClass.state as Specification.PlotSegmentState;
        for (const glyph of plotSegmentState.glyphs) {
          this.addObject(table, this.manager.getClass(glyph));
          for (const mark of glyph.marks) {
            this.addObject(table, this.manager.getClass(mark));
          }
          // Only one glyph is enough.
          break;
        }
      }
    }

    for (const scaleState of this.manager.chartState.scales) {
      this.addObject(null, this.manager.getClass(scaleState));
    }

    this.addObject(null, this.manager.getChartClass(this.manager.chartState));

    // Extract data tables
    template.tables = this.dataset.tables
      .map(table => {
        if (this.tableColumns.hasOwnProperty(table.name)) {
          return {
            name: table.name,
            columns: table.columns
              .filter(x => {
                return this.tableColumns[table.name].has(x.name);
              })
              .map(x => ({
                displayName: x.displayName || x.name,
                name: x.name,
                type: x.type,
                metadata: x.metadata
              }))
          };
        } else {
          return null;
        }
      })
      .filter(x => x != null);

    this.computeDefaultAttributes();
    return template;
  }

  /**
   * Computes the default attributes
   */
  private computeDefaultAttributes() {
    const counts = {} as any;

    // Go through all the mark instances
    this.manager.enumerateClassesByType("mark", (cls, state) => {
      const { _id } = cls.object;
      // Basic idea is sum up the attributes for each mark object, and then average them at the end
      const totals = (this.template.defaultAttributes[_id] =
        this.template.defaultAttributes[_id] || {});

      Object.keys(state.attributes).forEach(attribute => {
        // Only support numbers for now
        if (
          cls.attributes[attribute] &&
          cls.attributes[attribute].type === "number"
        ) {
          totals[attribute] = totals[attribute] || 0;
          totals[attribute] += state.attributes[attribute] || 0;
          counts[_id] = (counts[_id] || 0) + 1;
        }
      });
    });

    // The default attributes are currently totals, now divide each attribute by the count to average them
    Object.keys(this.template.defaultAttributes).forEach(objId => {
      const attribs = this.template.defaultAttributes[objId];
      Object.keys(attribs).forEach(attribute => {
        attribs[attribute] = attribs[attribute] / counts[objId];
      });
    });
  }
}
